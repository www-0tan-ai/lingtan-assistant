/**
 * 灵碳浏览器端与 Hermes API Server（Lingtan 云本地同步路由）对齐的常量契约。
 * - 服务端镜像：GET /v1/capabilities → lingtan_browser_sdk（运行时权威）
 * - 任意独立前端（自建 dev server）应复制此文件或通过 capabilities 对齐键名，
 *   勿再发明一套 localStorage 键或登录路径。
 * - 说明：Hermes CLI / ~/.hermes 凭据与 Lingtan JWT 无关；JWT 只对网关上的 /v1/* 路由有效。
 */
(function (w) {
  "use strict";
  /** @keep sync with gateway/platforms/api_server.py → lingtan_browser_sdk.contract_version */
  var CONTRACT_VERSION = 1;
  var C = {
    CONTRACT_VERSION: CONTRACT_VERSION,
    localStorageKeys: {
      accessToken: "wb_access_token",
      refreshToken: "wb_refresh_token",
      gatewayBearer: "wb_gateway_bearer",
      deviceId: "wb_device_id",
      syncCursor: "wb_sync_cursor",
      hermesSessionId: "wb_hermes_session_id",
      chatFork: "wb_chat_fork",
      subagent: "wb_subagent",
      subagentLegacy: "wb_sunagent",
    },
    paths: {
      register: "/v1/auth/register",
      login: "/v1/auth/login",
      refresh: "/v1/auth/refresh",
      logout: "/v1/auth/logout",
      capabilities: "/v1/capabilities",
    },
    jsonFields: {
      accessToken: "access_token",
      refreshToken: "refresh_token",
    },
  };
  w.LINGTAN_AUTH_CONTRACT = C;
})(typeof window !== "undefined" ? window : globalThis);
