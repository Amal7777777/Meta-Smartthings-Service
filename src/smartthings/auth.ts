import { getSecrets } from "../config.js";

/**
 * Supplies the bearer token used for SmartThings API calls on behalf of a WhatsApp user.
 *
 * Today every allowed sender shares one Personal Access Token. When you move to OAuth,
 * add an implementation that looks up the sender's stored tokens (e.g. in DynamoDB),
 * refreshes them when expired, and returns the access token; nothing else changes.
 */
export interface SmartThingsTokenProvider {
  getAccessToken(waUserId: string): Promise<string>;
}

export class PatTokenProvider implements SmartThingsTokenProvider {
  async getAccessToken(_waUserId: string): Promise<string> {
    return (await getSecrets()).SMARTTHINGS_PAT;
  }
}

/*
 * Sketch of the OAuth version, for later:
 *
 * export class OAuthTokenProvider implements SmartThingsTokenProvider {
 *   async getAccessToken(waUserId: string) {
 *     const tokens = await loadTokens(waUserId);            // DynamoDB, encrypted
 *     if (!tokens) throw new NotLinkedError(waUserId);       // reply with a link to connect
 *     if (tokens.expiresAt < Date.now() + 60_000) {
 *       // POST https://auth-global.api.smartthings.com/oauth/token
 *       //   grant_type=refresh_token, client id/secret via Basic auth
 *       tokens = await refresh(tokens);
 *       await saveTokens(waUserId, tokens);
 *     }
 *     return tokens.accessToken;
 *   }
 * }
 */

export function createTokenProvider(): SmartThingsTokenProvider {
  return new PatTokenProvider();
}
