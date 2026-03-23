export function getMessageResponseError(response, fallbackMessage) {
  const fallback = typeof fallbackMessage === 'string' && fallbackMessage ? fallbackMessage : '操作失败';
  const err = response && response.error;
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  if (typeof err === 'string' && err) {
    return err;
  }
  return fallback;
}

export function assertSuccessfulMessageResponse(response, fallbackMessage, options = {}) {
  const allowSkipped = !!(options && options.allowSkipped);
  const fallback = typeof fallbackMessage === 'string' && fallbackMessage ? fallbackMessage : '操作失败';

  if (!response || typeof response !== 'object') {
    throw new Error(fallback);
  }

  if (allowSkipped && response.skipped === true) {
    return response;
  }

  if (response.success === false) {
    throw new Error(getMessageResponseError(response, fallback));
  }

  if (response.success !== true) {
    throw new Error(fallback);
  }

  return response;
}
