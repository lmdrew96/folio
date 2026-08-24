/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as blocks from "../blocks.js";
import type * as crons from "../crons.js";
import type * as diff from "../diff.js";
import type * as documents from "../documents.js";
import type * as http from "../http.js";
import type * as mcpData from "../mcpData.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as reactions from "../reactions.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  blocks: typeof blocks;
  crons: typeof crons;
  diff: typeof diff;
  documents: typeof documents;
  http: typeof http;
  mcpData: typeof mcpData;
  messages: typeof messages;
  migrations: typeof migrations;
  reactions: typeof reactions;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
