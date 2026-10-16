I'm implementing Stage 1 (dataset acquisition & preprocessing) and Stage 2
(local graph prototype) of my project "Intelligent Microservice Dependency
Analysis & RCA Framework". Target directory: Intelligent-Microservice-RCA-Framework/

============================================================
PART A — Dataset acquisition
============================================================

Dataset: Alibaba Cluster Trace Program, "cluster-trace-microservices-v2021"
Repo: https://github.com/alibaba/clusterdata/tree/master/cluster-trace-microservices-v2021
Table to use: MS_CallGraph_Table (files named MSCallGraph_<N>.tar.gz)

Exact confirmed schema for MSCallGraph rows (no header row in raw files —
confirm this against the actual downloaded file before assuming):
  timestamp   - int, ms offset from trace start (0 to 43,200,000 for 12h)
  traceid     - string, unique per end-to-end request
  rpcid       - string, hierarchical e.g. "0.1.1.2.50" — the parent call's
                rpcid is this string with its last "." segment removed
  um          - string, upstream (calling) microservice name/hash
  rpctype     - string: "rpc", "db", "mc", "http", or "mq"
  interface   - string, the DM interface/endpoint called (rpc/http only)
  dm          - string, downstream (called) microservice name/hash
  rt          - int, response time in ms. For rpctype=rpc, EVERY call is
                recorded TWICE (once logged by um, once by dm) with the
                SAME traceid+rpcid: the um-side row has rt = um's positive
                round-trip time, the dm-side row has rt = NEGATIVE of dm's
                own processing time. Take abs(rt) and pick ONE of the two
                duplicate rows per (traceid, rpcid) — do not sum or average
                the raw signed values together.

Steps:
1. Do NOT download the full ~25Gi MSCallGraph directory. Open fetchData.sh
   in the repo, identify the download URL pattern for individual
   MSCallGraph_<N>.tar.gz part files, and fetch only ONE part file
   (part 0 is fine) — this alone will contain well over a few hundred
   thousand rows.
2. Extract it into dataset/raw/MSCallGraph_0.csv (or whatever the actual
   extracted filename is — verify, don't assume .csv).
3. Load a sample of ~1000 rows first and print them to confirm the column
   order matches the schema above before processing the full file — the
   raw CSVs have NO header row, so an off-by-one column assumption will
   silently corrupt everything downstream.
4. Note and log (don't silently drop) any row where um, dm, or rpcid is
   missing, empty, "NAN", or "(?)" — filter these out but report the count.

============================================================
PART B — preprocess_traces.py
============================================================

Write dataset/preprocess_traces.py that:

1. Reads the raw CSV with the correct column names (see schema above).
2. Filters out rows with missing/NAN/(?) in um, dm, or rpcid.
3. For rpctype == "rpc": deduplicates each (traceid, rpcid) pair down to
   ONE row, taking abs(rt) as the call's latency. Prefer keeping the
   um-side (positive-rt) record when both exist for clarity, but the
   dedup logic should not assume both are always present (missing data
   is common per the dataset's own docs).
4. For rpctype in ("db", "mc", "http", "mq"): rt is not double-recorded
   the same way — do not apply the dedup/sign logic above to these; treat
   rt as-is (already non-negative per the docs), just take abs(rt) defensively.
5. Reconstructs the call TREE per traceid using the rpcid hierarchy
   (parent = rpcid with last "." segment stripped), not just flat pairs —
   store parent_rpcid as a column so Stage 2/3 can use call-order structure
   later if needed, even if the initial graph only uses flat pair aggregation.
6. Aggregates across ALL traces into service-pair edges:
   (um) -[CALLS]-> (dm) with properties:
     - call_count      : number of calls observed for this um->dm pair
     - avg_latency_ms   : mean of abs(rt) for this pair
     - p95_latency_ms   : 95th percentile of abs(rt) for this pair
     - rpctype           : the dominant/most common rpctype for this pair
   Do NOT include an "error_rate" field — the raw dataset has no ground-
   truth failure signal. Note this explicitly in a code comment so it's
   clear this is intentional, not an oversight.
7. Emits two output files to dataset/processed/:
     - nodes.csv   : one row per unique service name (um or dm), columns:
                      service_name, total_calls_as_um, total_calls_as_dm
     - edges.csv   : one row per (um, dm) pair with the aggregated
                      properties from step 6
8. Prints summary stats at the end: total raw rows read, rows filtered
   out (with reason breakdown), unique services found, unique edges found,
   and the top 10 edges by call_count — this is what I'll use to sanity-
   check against the checkpoint below.

============================================================
PART C — Local graph prototype (Neo4j)
============================================================

1. Add a docker-compose.yml (in the project root or a local/ subfolder)
   that runs Neo4j 5.x community edition with:
     - ports 7474 (browser) and 7687 (bolt) exposed
     - NEO4J_AUTH set to neo4j/<a placeholder password>, called out in a
       comment as something to change
     - a named volume for data persistence across restarts

2. Write dataset/load_to_neo4j.py using the official `neo4j` Python
   driver (not raw HTTP) that:
     - connects to bolt://localhost:7687
     - reads nodes.csv and edges.csv from Part B
     - creates Service nodes with a `name` property (and total_calls_as_um/
       dm as extra properties), using MERGE (not CREATE) so re-running the
       script is idempotent
     - creates CALLS relationships between Service nodes using MERGE,
       setting call_count, avg_latency_ms, p95_latency_ms, rpctype as
       relationship properties
     - batches writes using UNWIND with parameterized Cypher (do not
       execute one Cypher statement per row in a Python loop — this will
       be extremely slow for anything beyond a few thousand edges)
     - prints a final count of nodes and relationships created

3. After loading, run and print the results of these verification queries
   via the Python driver (don't just tell me to check them in the browser
   — actually run them and show me the output):
     a. MATCH (n:Service) RETURN count(n)
     b. MATCH ()-[r:CALLS]->() RETURN count(r)
     c. MATCH (caller)-[r:CALLS]->(callee {name: <pick the busiest dm from
        the Part B top-10 output>}) RETURN caller.name, r.call_count,
        r.avg_latency_ms ORDER BY r.call_count DESC
     d. MATCH (n:Service) WHERE NOT (n)-[:CALLS]->() AND NOT ()-[:CALLS]->(n)
        RETURN count(n)  -- sanity check for orphaned/disconnected nodes

============================================================
CHECKPOINTS TO CONFIRM BEFORE MOVING ON
============================================================

Stage 1 checkpoint: pick 2-3 actual traceid values from the processed
data, manually filter the raw CSV for just those traceids, hand-trace
the rpcid hierarchy for each, and confirm the edges.csv output for those
services matches what you'd compute by hand. Show me this comparison.

Stage 2 checkpoint: run query (c) above for payment-service or whatever
the actual busiest service name in the data turns out to be (the real
service names in this dataset are anonymized hashes, not friendly names
like "payment-service" — flag this to me, since it means the demo/review
narrative needs either a synthetic friendly-name mapping layer, or we
present the real hashed IDs and explain why).

Do all of this step by step, showing output at each stage rather than
running everything silently — I want to verify correctness before moving
to Stage 3.