export function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA < 1e-10 || normB < 1e-10)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
