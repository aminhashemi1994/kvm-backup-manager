/**
 * Normalizes an API error into a plain string suitable for rendering.
 *
 * The backend is inconsistent about error shapes: route handlers return
 * `{ success: false, error: "message" }`, while anything that falls through to
 * the global error handler returns `{ success: false, error: { message } }`.
 * Passing the latter straight into a toast or JSX throws React error #31
 * ("Objects are not valid as a React child") and unmounts the tree, which turns
 * a recoverable 500 into a blank page.
 */
export function getErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  const data = (error as any)?.response?.data
  const apiError = data?.error

  if (typeof apiError === 'string' && apiError) return apiError
  if (apiError && typeof apiError === 'object' && typeof apiError.message === 'string' && apiError.message) {
    return apiError.message
  }
  if (typeof data?.message === 'string' && data.message) return data.message

  const message = (error as any)?.message
  if (typeof message === 'string' && message) return message

  return fallback
}
