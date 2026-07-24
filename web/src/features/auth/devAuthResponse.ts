/**
 * Parses a successful local dev-auth response without conflating response
 * protocol failures with failures to reach the backend.
 */
export async function parseDevAuthAccessToken(
  response: Pick<Response, "json">,
): Promise<string | undefined> {
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("access_token" in data) ||
    typeof data.access_token !== "string" ||
    !data.access_token
  ) {
    return undefined;
  }
  return data.access_token;
}
