import { type CursorModel } from "./models";
/**
 * Cloud Agents accepts either Bearer or Basic auth. Basic uses the API key
 * as the username and an empty password, which is the form documented at
 * https://cursor.com/docs/api.
 */
export declare function cursorCloudFetch(path: string, apiKey: string): Promise<Response>;
export declare function verifyCursorApiKey(apiKey: string): Promise<void>;
export declare function listCursorCloudModels(apiKey: string): Promise<CursorModel[] | null>;
export declare function accessTokenForCursorApiKey(apiKey: string): Promise<string>;
