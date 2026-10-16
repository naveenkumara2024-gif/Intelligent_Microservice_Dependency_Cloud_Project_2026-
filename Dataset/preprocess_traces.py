"""
Preprocess a raw MSCallGraph part file from the Alibaba
cluster-trace-microservices-v2021 dataset into a service dependency graph.

Input:  dataset/raw/MSCallGraph_0.csv
Output: dataset/processed/nodes.csv, dataset/processed/edges.csv

Confirmed against the actual downloaded file (do not trust the dataset's
docs blindly): MSCallGraph_0.csv DOES have a header row, with columns
(after dropping the leading unnamed row-index column) in this order:
traceid, timestamp, rpcid, um, rpctype, dm, interface, rt
"""

import sys
from pathlib import Path

import pandas as pd

RAW_PATH = Path(__file__).parent / "raw" / "MSCallGraph_0.csv"
OUT_DIR = Path(__file__).parent / "processed"

MISSING_STRING_SENTINELS = {"NAN", "(?)", ""}


def load_raw(path: Path) -> pd.DataFrame:
    df = pd.read_csv(
        path,
        usecols=["traceid", "rpcid", "um", "rpctype", "dm", "rt"],
        dtype={
            "traceid": "string",
            "rpcid": "string",
            "um": "string",
            "dm": "string",
            "rpctype": "category",
            "rt": "int64",
        },
    )
    return df


def filter_missing(df: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, int]]:
    """Drop rows with missing/NAN/(?) um, dm, or rpcid. Return (clean_df, reason_counts)."""
    reasons: dict[str, int] = {}
    mask_valid = pd.Series(True, index=df.index)

    for col in ("um", "dm", "rpcid"):
        col_bad = df[col].isna() | df[col].isin(MISSING_STRING_SENTINELS)
        reasons[f"missing_{col}"] = int(col_bad.sum())
        mask_valid &= ~col_bad

    return df[mask_valid], reasons


def dedupe_rpc_calls(df: pd.DataFrame) -> pd.DataFrame:
    """
    For rpctype == 'rpc', every call is logged twice (once by um, once by dm)
    under the same (traceid, rpcid), with rt positive on the um-side row and
    NEGATIVE on the dm-side row. Collapse each (traceid, rpcid) pair to a
    single row, preferring the positive-rt (um-side) record when both exist,
    but not assuming both are always present.
    """
    rpc_mask = df["rpctype"] == "rpc"
    rpc_rows = df[rpc_mask].copy()
    other_rows = df[~rpc_mask].copy()

    # Sort so that within each (traceid, rpcid) group, the positive-rt
    # (um-side) row comes first, then keep only the first row per group.
    rpc_rows["_abs_rt"] = rpc_rows["rt"].abs()
    rpc_rows["_is_positive"] = rpc_rows["rt"] > 0
    rpc_rows = rpc_rows.sort_values(
        ["traceid", "rpcid", "_is_positive"], ascending=[True, True, False]
    )
    rpc_deduped = rpc_rows.drop_duplicates(subset=["traceid", "rpcid"], keep="first")
    rpc_deduped = rpc_deduped.drop(columns=["_is_positive"])

    # Non-rpc rpctypes (db, mc, http, mq, userDefined, ...) are not
    # double-recorded the same way; rt is already non-negative per the
    # dataset docs, but we take abs() defensively.
    other_rows["_abs_rt"] = other_rows["rt"].abs()

    combined = pd.concat([rpc_deduped, other_rows], ignore_index=True)
    combined = combined.rename(columns={"_abs_rt": "latency_ms"})
    return combined


def add_parent_rpcid(df: pd.DataFrame) -> pd.DataFrame:
    """
    Reconstruct call-tree structure: parent_rpcid is rpcid with its last
    "." segment removed. Root calls (no "." in rpcid) get parent_rpcid = None.
    Stored for future stages (Stage 2/3) to use call-order structure; the
    initial graph below only uses flat (um, dm) pair aggregation.
    """
    def parent_of(rpcid: str) -> str | None:
        idx = rpcid.rfind(".")
        return rpcid[:idx] if idx != -1 else None

    df = df.copy()
    df["parent_rpcid"] = df["rpcid"].map(parent_of)
    return df


def build_nodes_and_edges(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    # NOTE: no "error_rate" field on edges — the raw dataset has no
    # ground-truth failure/error signal, so this is intentionally omitted
    # rather than an oversight.
    grouped = df.groupby(["um", "dm"], observed=True)

    edges = grouped["latency_ms"].agg(
        call_count="count",
        avg_latency_ms="mean",
        p95_latency_ms=lambda s: s.quantile(0.95),
    ).reset_index()

    dominant_rpctype = (
        df.groupby(["um", "dm"], observed=True)["rpctype"]
        .agg(lambda s: s.value_counts().idxmax())
        .reset_index(name="rpctype")
    )
    edges = edges.merge(dominant_rpctype, on=["um", "dm"])
    edges = edges.sort_values("call_count", ascending=False).reset_index(drop=True)

    calls_as_um = df.groupby("um", observed=True).size().rename("total_calls_as_um")
    calls_as_dm = df.groupby("dm", observed=True).size().rename("total_calls_as_dm")
    all_services = pd.Index(
        pd.concat([df["um"], df["dm"]]).unique(), name="service_name"
    )
    nodes = pd.DataFrame(index=all_services).join(calls_as_um).join(calls_as_dm)
    nodes = nodes.fillna(0).reset_index()
    nodes["total_calls_as_um"] = nodes["total_calls_as_um"].astype(int)
    nodes["total_calls_as_dm"] = nodes["total_calls_as_dm"].astype(int)

    return nodes, edges


def main() -> None:
    if not RAW_PATH.exists():
        print(f"Raw file not found: {RAW_PATH}", file=sys.stderr)
        sys.exit(1)

    print(f"Reading {RAW_PATH} ...")
    raw = load_raw(RAW_PATH)
    total_raw_rows = len(raw)
    print(f"Total raw rows read: {total_raw_rows:,}")

    clean, reasons = filter_missing(raw)
    total_filtered = total_raw_rows - len(clean)

    deduped = dedupe_rpc_calls(clean)
    deduped = add_parent_rpcid(deduped)

    nodes, edges = build_nodes_and_edges(deduped)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    nodes_path = OUT_DIR / "nodes.csv"
    edges_path = OUT_DIR / "edges.csv"
    nodes.to_csv(nodes_path, index=False)
    edges.to_csv(edges_path, index=False)

    print("\n=== Summary ===")
    print(f"Total raw rows read: {total_raw_rows:,}")
    print(f"Rows filtered out: {total_filtered:,}")
    for reason, count in reasons.items():
        print(f"  - {reason}: {count:,}")
    print(f"Rows after filtering: {len(clean):,}")
    print(f"Rows after rpc-call dedup: {len(deduped):,}")
    print(f"Unique services found: {len(nodes):,}")
    print(f"Unique (um -> dm) edges found: {len(edges):,}")
    print(f"\nWrote {nodes_path}")
    print(f"Wrote {edges_path}")

    print("\nTop 10 edges by call_count:")
    print(edges.head(10).to_string(index=False))


if __name__ == "__main__":
    main()
