# Agentic eval scorecard — 2026-06-16T00-31-13-601Z

Golden suite of 16 natural-language asks scored deterministically (right command + sane args, no hallucinations). Ranked best-first.

| # | provider | model | pass | hallucinations | errors | avg ms |
|---|----------|-------|------|----------------|--------|--------|
| 1 | xai | `grok-4.20-0309-non-reasoning` | **100%** (16/16) | 0% | 0 | 659 |
| 2 | openai | `gpt-5.4-mini` | **100%** (16/16) | 0% | 0 | 738 |
| 3 | openai | `gpt-4.1-mini` | **100%** (16/16) | 0% | 0 | 982 |
| 4 | openai | `gpt-4.1-mini-2025-04-14` | **100%** (16/16) | 0% | 0 | 1136 |
| 5 | gemini | `gemini-2.5-flash` | **100%** (16/16) | 0% | 0 | 1149 |
| 6 | deepseek | `deepseek-v4-flash` | **100%** (16/16) | 0% | 0 | 1862 |
| 7 | xai | `grok-4.3` | **100%** (16/16) | 0% | 0 | 2105 |
| 8 | deepseek | `deepseek-v4-pro` | **100%** (16/16) | 0% | 0 | 2975 |
| 9 | gemini | `gemini-2.5-pro` | **100%** (16/16) | 0% | 0 | 3459 |
| 10 | xai | `grok-4.20-0309-reasoning` | **100%** (16/16) | 0% | 0 | 5344 |
| 11 | gemini | `gemini-2.5-flash-lite` | **88%** (14/16) | 0% | 0 | 562 |

## Hardest cases (failed by N of the scored models)

- `clarify-vague` — failed by 1/11 models — _want: intent HUH, no commands_
- `neural` — failed by 1/11 models — _want: add_neural_insert on t-bass_

## Failures by model

### xai `grok-4.20-0309-non-reasoning` — clean sweep ✅

### openai `gpt-5.4-mini` — clean sweep ✅

### openai `gpt-4.1-mini` — clean sweep ✅

### openai `gpt-4.1-mini-2025-04-14` — clean sweep ✅

### gemini `gemini-2.5-flash` — clean sweep ✅

### deepseek `deepseek-v4-flash` — clean sweep ✅

### xai `grok-4.3` — clean sweep ✅

### deepseek `deepseek-v4-pro` — clean sweep ✅

### gemini `gemini-2.5-pro` — clean sweep ✅

### xai `grok-4.20-0309-reasoning` — clean sweep ✅

### gemini `gemini-2.5-flash-lite` — 2 failed
- `clarify-vague`: emitted [—]
- `neural`: emitted [load_plugin]
