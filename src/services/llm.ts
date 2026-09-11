import { type FlowSettings, loadLlmToken, resolveLlmBaseUrl, resolveLlmModel } from '../main/settings'

export class LlmError extends Error {
	readonly kind: 'auth' | 'network' | 'provider' | 'empty'
	constructor(kind: LlmError['kind'], message: string) {
		super(message)
		this.kind = kind
	}
}

export interface LlmClient {
	readonly name: string
	summarize(transcript: string): Promise<string>
}

const SUMMARY_SYSTEM_PROMPT =
	'Summarize the following meeting transcript. Reply in the same language as the transcript. ' +
	'Format: key points, then decisions, then action items. Be concise.'

const SUMMARY_MAX_CHARS = 120000
const SUMMARY_HEAD_CHARS = 90000
const SUMMARY_TAIL_CHARS = 30000

/** Long transcripts are trimmed middle-out so the summary still sees the opening and the close. */
export function truncateForSummary(transcript: string): string {
	if (transcript.length <= SUMMARY_MAX_CHARS) return transcript
	return `${transcript.slice(0, SUMMARY_HEAD_CHARS)}\n\n[…trimmed for length…]\n\n${transcript.slice(-SUMMARY_TAIL_CHARS)}`
}

type ErrorResponse = { error?: { message?: string } | string; message?: string }

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

export class OpenAiCompatibleLlm implements LlmClient {
	readonly name = 'openai-compatible'
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly model: string,
	) {}

	async summarize(transcript: string): Promise<string> {
		if (!this.token) throw new LlmError('auth', 'Missing LLM API key.')
		const text = truncateForSummary(transcript.trim())
		if (!text) throw new LlmError('empty', 'Nothing to summarize.')
		let response: Response
		try {
			response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: this.model,
					messages: [
						{ role: 'system', content: SUMMARY_SYSTEM_PROMPT },
						{ role: 'user', content: text },
					],
				}),
				signal: AbortSignal.timeout(120000),
			})
		} catch (error) {
			throw new LlmError('network', `LLM unreachable: ${error instanceof Error ? error.message : String(error)}`)
		}
		const data = await readJson(response)
		if (response.status === 401 || response.status === 403) throw new LlmError('auth', 'LLM authentication failed.')
		if (!response.ok) {
			const body = data as ErrorResponse
			const message = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? response.statusText)
			throw new LlmError('provider', `LLM ${response.status}: ${message}`)
		}
		const content = (data.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content
		if (typeof content !== 'string' || !content.trim()) throw new LlmError('empty', 'LLM returned no summary.')
		return content.trim()
	}
}

/** Null when no LLM key is configured — meeting summaries are optional. */
export function createLlmClient(settings?: FlowSettings, tokenOverride?: string): LlmClient | null {
	const token = tokenOverride ?? loadLlmToken()
	if (!token) return null
	return new OpenAiCompatibleLlm(
		resolveLlmBaseUrl(settings?.llmBaseUrl),
		token,
		resolveLlmModel(settings?.llmModel),
	)
}
