#!/usr/bin/env python
import argparse
import json
import math
import sqlite3
import sys
from pathlib import Path

# python scripts\search-vector-chunks.py 技术保障 --limit 3 --json

DEFAULT_SQLITE_PATH = Path(".data/sqlite/office-agent.sqlite3")
DEFAULT_QDRANT_PATH = Path(".data/qdrant/office-agent-qdrant.sqlite3")
DEFAULT_COLLECTION = "office_agent_chunks"
EMBEDDING_DIMENSIONS = 384
FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3
MASK_64 = 0xFFFFFFFFFFFFFFFF


def stable_embedding_hash(value: str) -> int:
    value_bytes = value.encode("utf-8")
    current = FNV_OFFSET
    for byte in value_bytes:
        current = ((current ^ byte) * FNV_PRIME) & MASK_64
    return current


def add_embedding_token(vector: list[float], token: str, weight: float) -> None:
    token_hash = stable_embedding_hash(token)
    index = token_hash % len(vector)
    sign = 1.0 if token_hash & (1 << 63) == 0 else -1.0
    vector[index] += weight * sign


def flush_ascii_word(vector: list[float], chars: list[str]) -> None:
    if not chars:
        return

    word = "".join(chars)
    add_embedding_token(vector, f"w:{word}", 1.0)
    for index in range(max(0, len(word) - 2)):
        add_embedding_token(vector, f"g:{word[index:index + 3]}", 0.45)
    chars.clear()


def embed_chunk_text(text: str) -> list[float]:
    vector = [0.0] * EMBEDDING_DIMENSIONS
    ascii_word: list[str] = []
    previous_cjk: str | None = None

    for character in text:
        if character.isascii() and character.isalnum():
            ascii_word.append(character.lower())
            previous_cjk = None
            continue

        flush_ascii_word(vector, ascii_word)

        if character.isalnum():
            add_embedding_token(vector, f"c:{character}", 0.7)
            if previous_cjk is not None:
                add_embedding_token(vector, f"b:{previous_cjk}{character}", 1.0)
            previous_cjk = character
        else:
            previous_cjk = None

    flush_ascii_word(vector, ascii_word)
    norm = math.sqrt(sum(value * value for value in vector))
    if norm:
        vector = [value / norm for value in vector]
    return vector


def normalize_distance(distance: str) -> str:
    normalized = distance.strip().lower()
    if normalized == "dot":
        return "Dot"
    if normalized in {"euclid", "euclidean"}:
        return "Euclid"
    if normalized == "manhattan":
        return "Manhattan"
    return "Cosine"


def score_vectors(query: list[float], candidate: list[float], distance: str) -> float:
    normalized = normalize_distance(distance)
    pairs = zip(query, candidate)
    if normalized == "Dot":
        return sum(left * right for left, right in pairs)
    if normalized == "Euclid":
        return math.sqrt(sum((left - right) ** 2 for left, right in pairs))
    if normalized == "Manhattan":
        return sum(abs(left - right) for left, right in pairs)

    dot = 0.0
    query_norm = 0.0
    candidate_norm = 0.0
    for left, right in zip(query, candidate):
        dot += left * right
        query_norm += left * left
        candidate_norm += right * right
    if query_norm == 0.0 or candidate_norm == 0.0:
        return 0.0
    return dot / (math.sqrt(query_norm) * math.sqrt(candidate_norm))


def passes_threshold(score: float, distance: str, min_score: float | None) -> bool:
    if min_score is None:
        return True
    normalized = normalize_distance(distance)
    if normalized in {"Euclid", "Manhattan"}:
        return score <= min_score
    return score >= min_score


def read_collection(qdrant: sqlite3.Connection, collection: str) -> tuple[int, str]:
    row = qdrant.execute(
        "SELECT vector_size, distance FROM qdrant_collections WHERE name = ?1",
        (collection,),
    ).fetchone()
    if row is None:
        raise SystemExit(f"Collection not found: {collection}")
    return int(row[0]), str(row[1])


def search_candidates(
    qdrant: sqlite3.Connection,
    collection: str,
    distance: str,
    query_vector: list[float],
    min_score: float | None,
    force_chunk_ids: set[str] | None = None,
) -> list[tuple[str, float]]:
    force_chunk_ids = force_chunk_ids or set()
    rows = qdrant.execute(
        "SELECT vector_json, payload_json FROM qdrant_points WHERE collection = ?1",
        (collection,),
    )
    candidates: list[tuple[str, float]] = []
    for vector_json, payload_json in rows:
        vector = json.loads(vector_json)
        payload = json.loads(payload_json)
        chunk_id = str(payload.get("chunk_id", "")).strip()
        if not chunk_id:
            continue

        score = score_vectors(query_vector, vector, distance)
        if passes_threshold(score, distance, min_score) or chunk_id in force_chunk_ids:
            candidates.append((chunk_id, score))

    reverse = normalize_distance(distance) not in {"Euclid", "Manhattan"}
    candidates.sort(key=lambda item: item[1], reverse=reverse)
    return candidates


def exact_match_chunk_ids(sqlite: sqlite3.Connection, query: str) -> set[str]:
    query = query.strip()
    if not query:
        return set()

    like_query = f"%{query}%"
    rows = sqlite.execute(
        """
        SELECT id
        FROM chunks
        WHERE title_path LIKE ?1
           OR content LIKE ?1
           OR plain_text LIKE ?1
        """,
        (like_query,),
    )
    return {str(row[0]) for row in rows}


def hydrate_hits(
    sqlite: sqlite3.Connection,
    candidates: list[tuple[str, float]],
) -> list[dict[str, object]]:
    hits: list[dict[str, object]] = []
    for chunk_id, score in candidates:
        row = sqlite.execute(
            """
            SELECT c.id,
                   c.document_id,
                   COALESCE(d.name, d.filename, c.file_name, ''),
                   c.chunk_type,
                   c.title_path,
                   c.content,
                   c.plain_text,
                   c.order_index
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE c.id = ?1
            """,
            (chunk_id,),
        ).fetchone()
        if row is None:
            continue

        hits.append(
            {
                "chunk_id": row[0],
                "document_id": row[1],
                "document_name": row[2],
                "chunk_type": row[3],
                "title_path": row[4],
                "score": score,
                "content": row[5],
                "plain_text": row[6],
                "order_index": row[7],
            }
        )
    return hits


def compact_match_text(value: object) -> str:
    return "".join(str(value or "").lower().split())


def lexical_relevance(query: str, hit: dict[str, object]) -> float:
    compact_query = compact_match_text(query)
    if not compact_query:
        return 0.0

    title = compact_match_text(hit.get("title_path"))
    content = compact_match_text(hit.get("content"))
    plain_text = compact_match_text(hit.get("plain_text"))

    relevance = 0.0
    if compact_query in title:
        relevance += 100.0
    if compact_query in content:
        relevance += 40.0
    elif compact_query in plain_text:
        relevance += 20.0

    terms = [compact_match_text(term) for term in query.split() if term.strip()]
    if len(terms) > 1:
        for term in terms:
            if not term:
                continue
            if term in title:
                relevance += 5.0
            elif term in content or term in plain_text:
                relevance += 1.0

    return relevance


def rerank_hits(
    query: str,
    hits: list[dict[str, object]],
    distance: str,
    limit: int,
) -> list[dict[str, object]]:
    reverse_vector = normalize_distance(distance) not in {"Euclid", "Manhattan"}

    def rank_key(hit: dict[str, object]) -> tuple[float, float, int]:
        vector_score = float(hit["score"])
        comparable_score = vector_score if reverse_vector else -vector_score
        return (
            lexical_relevance(query, hit),
            comparable_score,
            -int(hit["order_index"]),
        )

    hits.sort(key=rank_key, reverse=True)
    return hits[: max(1, limit)]


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description="Search embedded OfficeAgent vector chunks by keyword."
    )
    parser.add_argument("query", help="Keyword or sentence to search.")
    parser.add_argument("--limit", type=int, default=5, help="Max results. Default: 5.")
    parser.add_argument(
        "--min-score",
        type=float,
        default=0.03,
        help="Minimum score for Cosine/Dot, maximum distance for Euclid/Manhattan. Default: 0.03.",
    )
    parser.add_argument("--sqlite", type=Path, default=DEFAULT_SQLITE_PATH)
    parser.add_argument("--qdrant", type=Path, default=DEFAULT_QDRANT_PATH)
    parser.add_argument("--collection", default=DEFAULT_COLLECTION)
    parser.add_argument("--json", action="store_true", help="Print raw JSON hits.")
    parser.add_argument(
        "--content-chars",
        type=int,
        default=800,
        help="Content preview length in human output. Default: 800.",
    )
    args = parser.parse_args()

    if not args.sqlite.exists():
        raise SystemExit(f"SQLite database not found: {args.sqlite}")
    if not args.qdrant.exists():
        raise SystemExit(f"Qdrant database not found: {args.qdrant}")

    sqlite = sqlite3.connect(args.sqlite)
    qdrant = sqlite3.connect(args.qdrant)
    vector_size, distance = read_collection(qdrant, args.collection)

    query_vector = embed_chunk_text(args.query.strip())
    if len(query_vector) != vector_size:
        raise SystemExit(
            f"Vector dimension mismatch: collection={vector_size}, query={len(query_vector)}"
        )

    exact_chunk_ids = exact_match_chunk_ids(sqlite, args.query)
    candidates = search_candidates(
        qdrant,
        args.collection,
        distance,
        query_vector,
        args.min_score,
        exact_chunk_ids,
    )
    hits = rerank_hits(args.query, hydrate_hits(sqlite, candidates), distance, args.limit)

    if args.json:
        print(json.dumps(hits, ensure_ascii=False, indent=2))
        return 0

    print(
        f'Query: "{args.query}" | collection: {args.collection} | distance: {distance} | hits: {len(hits)}'
    )
    for index, hit in enumerate(hits, start=1):
        content = str(hit["content"]).strip()
        if len(content) > args.content_chars:
            content = content[: args.content_chars] + "\n...[truncated]"
        print()
        print(f"[{index}] score={float(hit['score']):.4f} order={hit['order_index']}")
        print(f"document={hit['document_name']}")
        print(f"type={hit['chunk_type']}")
        print(f"title={hit['title_path']}")
        print("content:")
        print(content)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
