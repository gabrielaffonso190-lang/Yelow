const secretEnvironmentName = /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|SERVICE_ROLE_KEY)/i;

function redact(text, env) {
  let safeText = String(text);
  const secretValues = Object.entries(env)
    .filter(([name, value]) => secretEnvironmentName.test(name)
      && typeof value === 'string'
      && value.length > 0)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);

  for (const secret of secretValues) {
    safeText = safeText.replaceAll(secret, '[REDACTED]');
  }

  return safeText
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^@/\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b((?:api[_-]?key|token|password|secret)\s*[=:]\s*)["']?[^,\s}"']+/gi, '$1[REDACTED]');
}

export function logError(context, error, { env = process.env, logger = console } = {}) {
  const name = error instanceof Error && error.name ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : '';

  logger.error(`${context}\n${JSON.stringify({
    name: redact(name, env),
    message: redact(message, env),
    stack: redact(stack, env),
  }, null, 2)}`);
}
