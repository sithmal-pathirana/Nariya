/**
 * Nariya — Differ
 * Text/JSON comparison using an LCS-based diff algorithm.
 * Produces character-level or line-level diffs with visual markup data.
 */

/**
 * Compute the Longest Common Subsequence table
 * @param {string[]} a - First sequence
 * @param {string[]} b - Second sequence
 * @returns {number[][]}
 */
function lcsTable(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    return dp;
}

/**
 * Backtrack through the LCS table to produce a diff
 * @param {number[][]} dp
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{ type: 'equal' | 'add' | 'remove', value: string }>}
 */
function backtrack(dp, a, b) {
    const result = [];
    let i = a.length;
    let j = b.length;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            result.unshift({ type: 'equal', value: a[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: 'add', value: b[j - 1] });
            j--;
        } else {
            result.unshift({ type: 'remove', value: a[i - 1] });
            i--;
        }
    }

    return result;
}

/**
 * Perform a line-level diff between two strings
 * @param {string} textA - Original text
 * @param {string} textB - Modified text
 * @returns {Array<{ type: 'equal' | 'add' | 'remove', value: string, lineNumber?: number }>}
 */
export function diffLines(textA, textB) {
    const linesA = textA.split('\n');
    const linesB = textB.split('\n');

    const dp = lcsTable(linesA, linesB);
    const rawDiff = backtrack(dp, linesA, linesB);

    // Add line numbers
    let lineA = 0;
    let lineB = 0;

    return rawDiff.map(chunk => {
        const entry = { ...chunk };

        switch (chunk.type) {
            case 'equal':
                lineA++;
                lineB++;
                entry.lineA = lineA;
                entry.lineB = lineB;
                break;
            case 'remove':
                lineA++;
                entry.lineA = lineA;
                break;
            case 'add':
                lineB++;
                entry.lineB = lineB;
                break;
        }

        return entry;
    });
}

/**
 * Perform a character-level diff between two strings
 * Useful for highlighting byte-level differences within a line.
 * @param {string} textA
 * @param {string} textB
 * @returns {Array<{ type: 'equal' | 'add' | 'remove', value: string }>}
 */
export function diffChars(textA, textB) {
    const charsA = textA.split('');
    const charsB = textB.split('');

    // For very long strings, fall back to line diff to avoid O(n²) on chars
    if (charsA.length > 5000 || charsB.length > 5000) {
        return diffLines(textA, textB);
    }

    const dp = lcsTable(charsA, charsB);
    const rawDiff = backtrack(dp, charsA, charsB);

    // Merge consecutive same-type chunks
    const merged = [];
    for (const chunk of rawDiff) {
        if (merged.length > 0 && merged[merged.length - 1].type === chunk.type) {
            merged[merged.length - 1].value += chunk.value;
        } else {
            merged.push({ ...chunk });
        }
    }

    return merged;
}

/**
 * Pretty-format JSON for comparison
 * @param {string} jsonStr
 * @returns {string}
 */
export function formatJson(jsonStr) {
    try {
        return JSON.stringify(JSON.parse(jsonStr), null, 2);
    } catch {
        return jsonStr;
    }
}

/**
 * Compare two JSON strings (formats them first)
 * @param {string} jsonA
 * @param {string} jsonB
 * @returns {{ lineDiff: Array, charDiff: Array, formattedA: string, formattedB: string }}
 */
export function diffJson(jsonA, jsonB) {
    const formattedA = formatJson(jsonA);
    const formattedB = formatJson(jsonB);

    return {
        lineDiff: diffLines(formattedA, formattedB),
        formattedA,
        formattedB
    };
}

/**
 * Generate diff statistics
 * @param {Array} diff
 * @returns {{ added: number, removed: number, unchanged: number }}
 */
export function diffStats(diff) {
    let added = 0;
    let removed = 0;
    let unchanged = 0;

    for (const chunk of diff) {
        switch (chunk.type) {
            case 'add': added++; break;
            case 'remove': removed++; break;
            case 'equal': unchanged++; break;
        }
    }

    return { added, removed, unchanged };
}
