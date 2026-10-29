const MAGPIE_GATEWAY_ENV_VARS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "ANTHROPIC_BASE_URL",
  "CODEX_API_BASE",
] as const;

const MAGPIE_DEFAULT_GATEWAY_PORT = "3425";

function trimUrl(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** True when the URL points at a local Magpie OpenAI-compatible gateway. */
export function isMagpieGatewayUrl(value: string | undefined | null): boolean {
  const raw = trimUrl(value);
  if (!raw) return false;

  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (host.includes("magpie")) {
    return true;
  }

  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (isLoopback && port === MAGPIE_DEFAULT_GATEWAY_PORT) {
    return true;
  }

  return false;
}

function readMagpieLabel(raw: Record<string, unknown>): boolean {
  const label = raw.magpie_label;
  return typeof label === "string" && label.trim().length > 0;
}

/** Magpie's /v1/models entries carry a magpie_label extension field. */
export function isMagpieOpenAiCatalogModel(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  return readMagpieLabel(raw as Record<string, unknown>);
}

export function shouldMarkModelRoutedViaMagpie(input: {
  readonly baseUrl?: string | null;
  readonly catalogModel?: unknown;
  readonly slug?: string;
}): boolean {
  if (isMagpieGatewayUrl(input.baseUrl)) {
    return true;
  }
  if (input.catalogModel !== undefined && isMagpieOpenAiCatalogModel(input.catalogModel)) {
    return true;
  }
  return false;
}

export function readMagpieGatewayUrlFromInstanceEnvironment(
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined,
): string | undefined {
  if (!environment) return undefined;
  for (const name of MAGPIE_GATEWAY_ENV_VARS) {
    const match = environment.find((entry) => entry.name === name);
    if (match && isMagpieGatewayUrl(match.value)) {
      return match.value.trim();
    }
  }
  return undefined;
}

/** Client-side fallback when discovery did not attach routedViaMagpie. */
export function inferMagpieRoutingForInstanceModel(input: {
  readonly slug: string;
  readonly routedViaMagpie?: boolean;
  readonly instanceUsesMagpieGateway: boolean;
}): boolean {
  if (input.routedViaMagpie) {
    return true;
  }
  if (!input.instanceUsesMagpieGateway) {
    return false;
  }
  return input.slug.includes("/");
}
