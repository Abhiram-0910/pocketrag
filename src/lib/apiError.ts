/** Structured failure from a Worker call — carries the HTTP status and any extra
 * fields (e.g. rate-limit's resetAt) the plain `Error.message` string can't. */
export class WorkerRequestError extends Error {
  status: number
  resetAt?: string

  constructor(message: string, status: number, resetAt?: string) {
    super(message)
    this.name = 'WorkerRequestError'
    this.status = status
    this.resetAt = resetAt
  }
}

/** Parses a non-ok Worker response into a WorkerRequestError, shared by every API call site. */
export async function parseWorkerErrorResponse(res: Response, fallbackMessage: string): Promise<WorkerRequestError> {
  const data = (await res.json().catch(() => null)) as { error?: string; resetAt?: string } | null
  return new WorkerRequestError(data?.error ?? fallbackMessage, res.status, data?.resetAt)
}
