//! Small dependency-free utilities: deterministic fingerprints and entropy.

/// FNV-1a 64-bit hash. Deterministic across runs and platforms (no random seed),
/// which is exactly what we want for stable finding fingerprints.
pub fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Build a stable fingerprint from parts. Intentionally excludes absolute line
/// numbers so a finding survives unrelated line shifts in the same file.
pub fn fingerprint(parts: &[&str]) -> String {
    format!("{:016x}", fnv1a(&parts.join("\u{1}")))
}

/// Shannon entropy (bits/char) over the byte distribution. Used for secret
/// detection: high-entropy tokens are more likely to be real credentials.
pub fn shannon_entropy(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let mut counts = [0usize; 256];
    let n = s.len() as f64;
    for b in s.bytes() {
        counts[b as usize] += 1;
    }
    let mut e = 0.0;
    for &c in counts.iter() {
        if c > 0 {
            let p = c as f64 / n;
            e -= p * p.log2();
        }
    }
    e
}

/// Collapse a code line into a normalization key for fingerprinting/dedup:
/// trims, collapses internal whitespace. Keeps identifiers/structure.
pub fn normalize_snippet(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for ch in s.trim().chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_is_stable() {
        assert_eq!(fnv1a("splus"), fnv1a("splus"));
        assert_ne!(fnv1a("a"), fnv1a("b"));
    }

    #[test]
    fn entropy_ranges() {
        assert!(shannon_entropy("aaaaaaaa") < 0.1);
        assert!(shannon_entropy("aZ3$kP9!mQ2vX7wL") > 3.0);
    }

    #[test]
    fn normalize_collapses_ws() {
        assert_eq!(normalize_snippet("  let   x =  1 "), "let x = 1");
    }
}
