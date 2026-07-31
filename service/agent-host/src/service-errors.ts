export class OpenAIUnavailableError extends Error {
  readonly code = "openai_unavailable";
}

export class OrchestrationUnavailableError extends Error {
  readonly code = "orchestration_unavailable";
}
