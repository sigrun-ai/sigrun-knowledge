/**
 * The guidance bullets the curator's review prompt shows for the
 * knowledge target (spec §6.3, plus the freshness ruling: fields that go
 * out of date carry a horizon so staleness is visible).
 */
export function guidance() {
    return [
        "Record the inquiry and its why (the purpose, in the user's words where possible).",
        "Find before creating: knowledge_find first, so entities de-duplicate across inquiries through identity keys.",
        "Reuse or extend an existing type before defining a new one; type names are lowercase singular phrases.",
        "When defining a type, give each field that goes out of date a horizonDays (prices ~30, opening hours ~180, addresses none).",
        "Cite every field: each value carries its source recall handle and observed date.",
        "Record the user's verdicts and outcomes, not your own guesses.",
        "Capture nothing from transient errors or one-off chatter.",
    ];
}
