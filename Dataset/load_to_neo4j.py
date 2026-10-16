"""
Load dataset/processed/nodes.csv and edges.csv into a local Neo4j 5.x
instance (see docker-compose.yml) and run verification queries.

Usage:
    python dataset/load_to_neo4j.py
"""

import os
from pathlib import Path

import pandas as pd
from neo4j import GraphDatabase

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "changeme123")

PROCESSED_DIR = Path(__file__).parent / "processed"
BATCH_SIZE = 5000

MERGE_NODES_QUERY = """
UNWIND $rows AS row
MERGE (s:Service {name: row.service_name})
SET s.total_calls_as_um = row.total_calls_as_um,
    s.total_calls_as_dm = row.total_calls_as_dm
"""

MERGE_EDGES_QUERY = """
UNWIND $rows AS row
MATCH (caller:Service {name: row.um})
MATCH (callee:Service {name: row.dm})
MERGE (caller)-[r:CALLS]->(callee)
SET r.call_count = row.call_count,
    r.avg_latency_ms = row.avg_latency_ms,
    r.p95_latency_ms = row.p95_latency_ms,
    r.rpctype = row.rpctype
"""


def batched(records: list[dict], size: int):
    for i in range(0, len(records), size):
        yield records[i : i + size]


def load_nodes(session, nodes_df: pd.DataFrame) -> None:
    records = nodes_df.to_dict("records")
    for batch in batched(records, BATCH_SIZE):
        session.run(MERGE_NODES_QUERY, rows=batch)


def load_edges(session, edges_df: pd.DataFrame) -> None:
    records = edges_df.to_dict("records")
    for batch in batched(records, BATCH_SIZE):
        session.run(MERGE_EDGES_QUERY, rows=batch)


def busiest_dm_from_top10(edges_df: pd.DataFrame) -> str:
    """Busiest dm among the Part B top-10-by-call_count edges (highest total call_count as a callee within that slice)."""
    top10 = edges_df.sort_values("call_count", ascending=False).head(10)
    return top10.groupby("dm")["call_count"].sum().idxmax()


def run_verification_queries(session, busiest_dm: str) -> None:
    print("\n=== Verification queries ===")

    print("\n(a) MATCH (n:Service) RETURN count(n)")
    result = session.run("MATCH (n:Service) RETURN count(n) AS count")
    print(result.single()["count"])

    print("\n(b) MATCH ()-[r:CALLS]->() RETURN count(r)")
    result = session.run("MATCH ()-[r:CALLS]->() RETURN count(r) AS count")
    print(result.single()["count"])

    print(f"\n(c) Callers of busiest dm ({busiest_dm}), ordered by call_count DESC")
    result = session.run(
        """
        MATCH (caller)-[r:CALLS]->(callee {name: $name})
        RETURN caller.name AS caller, r.call_count AS call_count, r.avg_latency_ms AS avg_latency_ms
        ORDER BY r.call_count DESC
        """,
        name=busiest_dm,
    )
    for record in result:
        print(dict(record))

    print("\n(d) Orphaned/disconnected Service nodes (no CALLS in or out)")
    result = session.run(
        """
        MATCH (n:Service)
        WHERE NOT (n)-[:CALLS]->() AND NOT ()-[:CALLS]->(n)
        RETURN count(n) AS count
        """
    )
    print(result.single()["count"])


def main() -> None:
    nodes_df = pd.read_csv(PROCESSED_DIR / "nodes.csv")
    edges_df = pd.read_csv(PROCESSED_DIR / "edges.csv")

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        driver.verify_connectivity()
        with driver.session() as session:
            print(f"Loading {len(nodes_df):,} nodes...")
            load_nodes(session, nodes_df)
            print(f"Loading {len(edges_df):,} edges...")
            load_edges(session, edges_df)

            node_count = session.run("MATCH (n:Service) RETURN count(n) AS c").single()["c"]
            rel_count = session.run("MATCH ()-[r:CALLS]->() RETURN count(r) AS c").single()["c"]
            print(f"\nFinal counts: {node_count:,} Service nodes, {rel_count:,} CALLS relationships")

            busiest_dm = busiest_dm_from_top10(edges_df)
            # Real service names in this dataset are anonymized hashes, not
            # friendly names like "payment-service" -- flagged per Stage 2
            # checkpoint. We query using the actual hashed id.
            print(f"\nBusiest dm from Part B top-10 output: {busiest_dm}")
            print(
                "NOTE: this dataset anonymizes service names as hashes, not "
                "friendly names -- see checkpoint notes."
            )
            run_verification_queries(session, busiest_dm)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
