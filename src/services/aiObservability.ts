import { posthog } from './posthog';

export interface AiObservabilityContext {
  sessionId: string;
  traceId: string;
}

// Default to capturing AI content. Set this before building to omit prompts,
// completions, and AI error details from manually captured generation events.
const privacyMode = process.env.EXPO_PUBLIC_POSTHOG_AI_PRIVACY_MODE === 'true';

const createId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// AI mode has no persisted conversation, so the JavaScript runtime is its session.
const sessionId = createId('ai-mode');

export function createAiTurn(): AiObservabilityContext {
  return { sessionId, traceId: createId('ai-turn') };
}

interface AiGenerationCapture {
  context: AiObservabilityContext;
  model: string;
  provider: string;
  requestUrl: string;
  schemaName: string;
  system: string;
  user: string;
  maxTokens: number;
  latencyMs: number;
  status?: number;
  output?: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  error?: string;
}

/** Records one completed or failed Groq generation without affecting the request. */
export function captureAiGeneration(generation: AiGenerationCapture): void {
  const properties: Record<string, any> = {
    $ai_trace_id: generation.context.traceId,
    $ai_session_id: generation.context.sessionId,
    $ai_span_name: generation.schemaName,
    $ai_model: generation.model,
    $ai_provider: generation.provider,
    $ai_latency: generation.latencyMs / 1000,
    $ai_request_url: generation.requestUrl,
    $ai_http_status: generation.status,
    $ai_input_tokens: generation.inputTokens,
    $ai_output_tokens: generation.outputTokens,
    $ai_stop_reason: generation.stopReason,
    $ai_temperature: 0.2,
    $ai_max_tokens: generation.maxTokens,
    $ai_stream: false,
    $ai_is_error: Boolean(generation.error),
  };

  if (!privacyMode) {
    properties.$ai_input = [
      { role: 'system', content: generation.system },
      { role: 'user', content: generation.user },
    ];
    if (generation.output) {
      properties.$ai_output_choices = [{ role: 'assistant', content: generation.output }];
    }
    if (generation.error) properties.$ai_error = generation.error;
  }

  try {
    // The existing React Native client preserves the app's anonymous identity.
    posthog?.capture('$ai_generation', properties);
  } catch {
    // Observability must never fail or delay an AI request.
  }
}
