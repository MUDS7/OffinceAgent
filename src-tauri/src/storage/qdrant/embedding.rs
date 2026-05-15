use super::super::document_index::IndexedChunk;

pub(super) const LOCAL_CHUNK_EMBEDDING_DIMENSIONS: usize = 384;
pub(super) const LOCAL_CHUNK_EMBEDDING_MODEL: &str = "office-agent-local-hash-v1";

pub(super) fn chunk_content_hash(chunk: &IndexedChunk) -> String {
    stable_content_hash(&chunk.plain_text)
}

pub(super) fn embed_chunk_text(text: &str) -> Vec<f32> {
    let mut vector = vec![0.0; LOCAL_CHUNK_EMBEDDING_DIMENSIONS];
    let mut ascii_word = String::new();
    let mut previous_cjk = None;

    for character in text.chars() {
        if character.is_ascii_alphanumeric() {
            ascii_word.push(character.to_ascii_lowercase());
            previous_cjk = None;
            continue;
        }

        flush_ascii_embedding_word(&mut vector, &mut ascii_word);

        if character.is_alphanumeric() {
            add_embedding_token(&mut vector, &format!("c:{character}"), 0.7);
            if let Some(previous) = previous_cjk {
                add_embedding_token(&mut vector, &format!("b:{previous}{character}"), 1.0);
            }
            previous_cjk = Some(character);
        } else {
            previous_cjk = None;
        }
    }

    flush_ascii_embedding_word(&mut vector, &mut ascii_word);
    normalize_embedding_vector(&mut vector);
    vector
}

fn stable_content_hash(value: &str) -> String {
    let hash = stable_embedding_hash(value);
    format!("{hash:016x}")
}

fn flush_ascii_embedding_word(vector: &mut [f32], word: &mut String) {
    if word.is_empty() {
        return;
    }

    add_embedding_token(vector, &format!("w:{word}"), 1.0);
    let chars = word.chars().collect::<Vec<_>>();
    for ngram in chars.windows(3) {
        let token = ngram.iter().collect::<String>();
        add_embedding_token(vector, &format!("g:{token}"), 0.45);
    }
    word.clear();
}

fn add_embedding_token(vector: &mut [f32], token: &str, weight: f32) {
    let hash = stable_embedding_hash(token);
    let index = (hash as usize) % vector.len();
    let sign = if hash & (1 << 63) == 0 { 1.0 } else { -1.0 };
    vector[index] += weight * sign;
}

fn normalize_embedding_vector(vector: &mut [f32]) {
    let norm = vector
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt();
    if norm == 0.0 {
        return;
    }

    for value in vector {
        *value = (f64::from(*value) / norm) as f32;
    }
}

fn stable_embedding_hash(value: &str) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    value.bytes().fold(FNV_OFFSET, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    })
}
