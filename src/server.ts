import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthContext } from "./auth.js";

import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  addItem,
  createBookmark,
  createList,
  ensureUser,
  findSourceItem,
  getItemsByList,
  getListById,
  getListSummaryById,
  getListsByOwner,
  getOrCreateListByType,
  getUserById,
  searchUsersByQuery,
  setItemStatus,
  updateItem,
} from "./db.js";
import { AuthError, buildProtectedResourceMetadata, getAuthContext } from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_PATH = process.env.MCP_PATH ?? "/mcp";
const PORT = Number(process.env.PORT ?? 3000);
const WIDGET_PATH = join(__dirname, "..", "public", "alister-widget.html");

const widgetHtml = readFileSync(WIDGET_PATH, "utf8");

const listTypeSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-zA-Z0-9 _-]+$/, "Type must be simple text");

const toolOutputTemplate = "ui://widget/alister.html";
const DEV_TOOLS_ENABLED = process.env.DEV_TOOLS === "true";

function buildStructuredResponse(
  payload: Record<string, unknown>,
  message: string
): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: payload,
  };
}

function requireListOwner(listOwnerId: string, viewerId: string) {
  if (listOwnerId !== viewerId) {
    throw new Error("You can only modify your own lists.");
  }
}

async function buildViewerSummary(viewerId: string) {
  const viewer = await getUserById(viewerId);
  if (!viewer) {
    throw new Error("Viewer not found.");
  }
  return {
    id: viewer.id,
    handle: viewer.handle,
    displayName: viewer.display_name,
    avatarUrl: viewer.avatar_url,
  };
}

async function buildListView(params: {
  viewerId: string;
  listId: string | null;
}): Promise<Record<string, unknown>> {
  const viewer = await buildViewerSummary(params.viewerId);
  const lists = await getListsByOwner(params.viewerId);
  if (!params.listId && lists[0]) {
    params.listId = lists[0].id;
  }
  if (!params.listId) {
    return {
      viewer,
      devTools: DEV_TOOLS_ENABLED,
      mode: "mine",
      lists,
      selectedList: null,
      itemsActive: [],
      itemsDone: [],
      profileUser: null,
      profileLists: null,
      searchResults: null,
    };
  }

  const selected = await getListSummaryById(params.listId);
  if (!selected) {
    throw new Error("List not found.");
  }

  const itemsActive = await getItemsByList(params.listId, "active");
  const itemsDone = await getItemsByList(params.listId, "done");

  if (selected.owner_id !== params.viewerId) {
    const profileRecord = await getUserById(selected.owner_id);
    const profileUser = profileRecord
      ? {
          id: profileRecord.id,
          handle: profileRecord.handle,
          displayName: profileRecord.display_name,
          avatarUrl: profileRecord.avatar_url,
        }
      : {
          id: selected.owner_id,
          handle: selected.owner_handle,
          displayName: selected.owner_display_name,
          avatarUrl: null,
        };
    const profileLists = await getListsByOwner(selected.owner_id);
    return {
      viewer,
      devTools: DEV_TOOLS_ENABLED,
      mode: "profile",
      lists,
      selectedList: selected,
      itemsActive,
      itemsDone,
      profileUser,
      profileLists,
      searchResults: null,
    };
  }

  return {
    viewer,
    devTools: DEV_TOOLS_ENABLED,
    mode: "mine",
    lists,
    selectedList: selected,
    itemsActive,
    itemsDone,
    profileUser: null,
    profileLists: null,
    searchResults: null,
  };
}

async function buildProfileView(params: {
  viewerId: string;
  profileUserId: string;
  listId?: string | null;
}): Promise<Record<string, unknown>> {
  const viewer = await buildViewerSummary(params.viewerId);
  const lists = await getListsByOwner(params.viewerId);
  const profileRecord = await getUserById(params.profileUserId);
  if (!profileRecord) {
    throw new Error("Profile user not found.");
  }
  const profileUser = {
    id: profileRecord.id,
    handle: profileRecord.handle,
    displayName: profileRecord.display_name,
    avatarUrl: profileRecord.avatar_url,
  };
  const profileLists = await getListsByOwner(params.profileUserId);
  let listId = params.listId ?? profileLists[0]?.id ?? null;
  if (!listId) {
    return {
      viewer,
      devTools: DEV_TOOLS_ENABLED,
      mode: "profile",
      lists,
      selectedList: null,
      itemsActive: [],
      itemsDone: [],
      profileUser,
      profileLists,
      searchResults: null,
    };
  }
  const selected = await getListSummaryById(listId);
  if (!selected) {
    throw new Error("List not found.");
  }
  const itemsActive = await getItemsByList(listId, "active");
  const itemsDone = await getItemsByList(listId, "done");

  return {
    viewer,
    devTools: DEV_TOOLS_ENABLED,
    mode: selected.owner_id === params.viewerId ? "mine" : "profile",
    lists,
    selectedList: selected,
    itemsActive,
    itemsDone,
    profileUser: selected.owner_id === params.viewerId ? null : profileUser,
    profileLists: selected.owner_id === params.viewerId ? null : profileLists,
    searchResults: null,
  };
}

async function buildSearchView(viewerId: string, query: string) {
  const viewer = await buildViewerSummary(viewerId);
  const lists = await getListsByOwner(viewerId);
  const results = query ? await searchUsersByQuery(query) : [];
  return {
    viewer,
    devTools: DEV_TOOLS_ENABLED,
    mode: "search",
    lists,
    selectedList: null,
    itemsActive: [],
    itemsDone: [],
    profileUser: null,
    profileLists: null,
    searchResults: results.map((user) => ({
      id: user.id,
      handle: user.handle,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
    })),
  };
}

function createMcpServer(authContext: AuthContext) {
  const server = new McpServer({
    name: "a-lister",
    version: "0.1.0",
  });

  let viewerCache: Awaited<ReturnType<typeof ensureUser>> | null = null;
  const getViewer = async () => {
    if (!viewerCache) {
      viewerCache = await ensureUser({
        authProviderId: authContext.authProviderId,
        handle: authContext.handle,
        displayName: authContext.displayName ?? null,
        avatarUrl: authContext.avatarUrl ?? null,
      });
    }
    return viewerCache;
  };

  server.registerResource(
    "alister-widget",
    "ui://widget/alister.html",
    {},
    async () => ({
      contents: [
        {
          uri: "ui://widget/alister.html",
          mimeType: "text/html+skybridge",
          text: widgetHtml,
        },
      ],
    })
  );

  server.registerTool(
    "list_my_lists",
    {
      title: "List my lists",
      description: "Get the current user lists.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: { "openai/outputTemplate": toolOutputTemplate },
    },
    async () => {
      const viewer = await getViewer();
      const view = await buildListView({ viewerId: viewer.id, listId: null });
      return buildStructuredResponse({ view }, "Here are your lists.");
    }
  );

  server.registerTool(
    "get_list",
    {
      title: "Get list",
      description: "Get a specific list and its items.",
      inputSchema: z.object({ list_id: z.string().uuid() }),
      annotations: { readOnlyHint: true },
      _meta: { "openai/outputTemplate": toolOutputTemplate },
    },
    async ({ list_id }) => {
      const viewer = await getViewer();
      const view = await buildListView({ viewerId: viewer.id, listId: list_id });
      return buildStructuredResponse({ view }, "List loaded.");
    }
  );

  server.registerTool(
    "create_list",
    {
      title: "Create list",
      description: "Create a new list for the current user.",
      inputSchema: z.object({
        title: z.string().min(1).max(120),
        type: listTypeSchema.default("general"),
      }),
      _meta: { "openai/outputTemplate": toolOutputTemplate },
    },
    async ({ title, type }) => {
      const viewer = await getViewer();
      const listId = await createList({ ownerId: viewer.id, title, type });
      const view = await buildListView({ viewerId: viewer.id, listId });
      return buildStructuredResponse({ view, effects: { lastCreatedListId: listId } }, "List created.");
    }
  );

  server.registerTool(
    "add_item",
    {
      title: "Add item",
      description: "Add an item to a list.",
      inputSchema: z.object({
        list_id: z.string().uuid(),
        title: z.string().min(1).max(160),
        note: z.string().max(280).optional().nullable(),
        url: z.string().url().optional().nullable(),
      }),
      _meta: { "openai/outputTemplate": toolOutputTemplate },
    },
    async ({ list_id, title, note, url }) => {
      const viewer = await getViewer();
      const list = await getListById(list_id);
      if (!list) throw new Error("List not found.");
      requireListOwner(list.owner_id, viewer.id);
      const itemId = await addItem({ listId: list_id, title, note, url });
      const view = await buildListView({ viewerId: viewer.id, listId: list_id });
      return buildStructuredResponse(
        { view, effects: { lastAddedItemId: itemId } },
        "Item added."
      );
    }
  );

  server.registerTool(
    "update_item",
    {
      title: "Update item",
      description: "Update an item in a list.",
      inputSchema: z.object({
        list_id: z.string().uuid(),
        item_id: z.string().uuid(),
        title: z.string().min(1).max(160).optional(),
        note: z.string().max(280).optional().nullable(),
        url: z.string().url().optional().nullable(),
      }),
      _meta: { "openai/outputTemplate": toolOutputTemplate },
    },
    async ({ list_id, item_id, title, note, url }) => {
      const viewer = await getViewer();
      const list = await getListById(list_id);
      if (!list) throw new Error("List not found.");
      requireListOwner(list.owner_id, viewer.id);
      await updateItem({ itemId: item_id, listId: list_id, title, note, url });
      const view = await buildListView({ viewerId: viewer.id, listId: list_id });
      return buildStructuredResponse({ view }, "Item updated.");
    }
  );

  server.registerTool(
    "set_item_status",
    {
      title: "Set item status",
      description: "Move an item between main and done.",
      inputSchema: z.object({
        list_id: z.string().uuid(),
        item_id: z.string().uuid(),
        status: z.enum(["active", "done"]),
      }),
      _meta: { "openai/outputTemplate": toolOutputTemplate },
    },
    async ({ list_id, item_id, status }) => {
      const viewer = await getViewer();
      const list = await getListById(list_id);
      if (!list) throw new Error("List not found.");
      requireListOwner(list.owner_id, viewer.id);
      await setItemStatus({ listId: list_id, itemId: item_id, status });
      const view = await buildListView({ viewerId: viewer.id, listId: list_id });
      return buildStructuredResponse(
        { view, effects: { lastMovedItemId: item_id, lastMoveTo: status } },
        "Item moved."
      );
    }
  );

  server.registerTool(
    "bookmark_item",
    {
      title: "Bookmark item",
      description: "Copy an item from another user into the current user's list.",
      inputSchema: z.object({
        source_item_id: z.string().uuid(),
        viewing_list_id: z.string().uuid().optional().nullable(),
      }),
      _meta: { "openai/outputTemplate": toolOutputTemplate },
    },
    async ({ source_item_id, viewing_list_id }) => {
      const viewer = await getViewer();
      const viewerId = viewer.id;
      const source = await findSourceItem(source_item_id);
      if (!source) throw new Error("Source item not found.");
      if (source.owner_id === viewerId) {
        const view = await buildListView({ viewerId, listId: viewing_list_id ?? source.list_id });
        return buildStructuredResponse(
          { view, effects: { lastBookmarkItemId: source_item_id } },
          "That item is already yours."
        );
      }

      const targetListId = await getOrCreateListByType({
        ownerId: viewerId,
        type: source.list_type,
        fallbackTitle: source.list_title,
      });

      const createdItemId = await addItem({
        listId: targetListId,
        title: source.title,
        note: source.note,
        url: source.url,
      });

      await createBookmark({
        userId: viewerId,
        sourceItemId: source.id,
        sourceListId: source.list_id,
        sourceUserId: source.owner_id,
        createdItemId,
      });

      const view = viewing_list_id
        ? await buildListView({ viewerId, listId: viewing_list_id })
        : await buildListView({ viewerId, listId: targetListId });

      return buildStructuredResponse(
        { view, effects: { lastBookmarkItemId: source_item_id } },
        "Item bookmarked."
      );
    }
  );

  server.registerTool(
    "search_users",
    {
      title: "Search users",
      description: "Search for public users by handle or display name.",
      inputSchema: z.object({ query: z.string().min(1).max(120) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { "openai/outputTemplate": toolOutputTemplate },
    },
    async ({ query }) => {
      const viewer = await getViewer();
      const view = await buildSearchView(viewer.id, query);
      return buildStructuredResponse({ view }, "Search results.");
    }
  );

  server.registerTool(
    "get_user_profile",
    {
      title: "Get user profile",
      description: "Get a user's public profile and lists.",
      inputSchema: z.object({ user_id: z.string().uuid() }),
      annotations: { readOnlyHint: true },
      _meta: { "openai/outputTemplate": toolOutputTemplate },
    },
    async ({ user_id }) => {
      const viewer = await getViewer();
      const view = await buildProfileView({ viewerId: viewer.id, profileUserId: user_id });
      return buildStructuredResponse({ view }, "Profile loaded.");
    }
  );

  if (DEV_TOOLS_ENABLED) {
    server.registerTool(
      "seed_demo_user",
      {
        title: "Seed demo user",
        description: "Create a demo user with a public list and one item (dev only).",
        inputSchema: z.object({}),
        _meta: { "openai/outputTemplate": toolOutputTemplate },
      },
      async () => {
        const viewer = await getViewer();
        const suffix = Math.random().toString(36).slice(2, 8);
        const handle = `demo_${suffix}`;
        const authProviderId = `dev-demo-${Date.now()}-${suffix}`;
        const demoUser = await ensureUser({
          authProviderId,
          handle,
          displayName: `Demo ${suffix.toUpperCase()}`,
          avatarUrl: null,
        });
        const listId = await createList({
          ownerId: demoUser.id,
          title: "Demo List",
          type: "general",
        });
        await addItem({ listId, title: "Sample item" });
        const view = await buildSearchView(viewer.id, handle);
        return buildStructuredResponse({ view }, `Seeded demo user @${demoUser.handle}.`);
      }
    );
  }

  return server;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id, X-User-Handle",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && url.pathname === MCP_PATH) {
    const acceptHeader = Array.isArray(req.headers["accept"])
      ? req.headers["accept"].join(",")
      : req.headers["accept"] ?? "";
    const wantsStream = acceptHeader.includes("text/event-stream");
    if (!wantsStream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "a-lister", version: "0.1.0" }));
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildProtectedResourceMetadata()));
    return;
  }

  if (url.pathname === MCP_PATH || url.pathname.startsWith(`${MCP_PATH}/`)) {
    try {
      const authContext = await getAuthContext(req);
      const mcpServer = createMcpServer(authContext);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");

      await transport.handleRequest(req, res);
      return;
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 500;
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }));
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`A-Lister MCP server listening on http://localhost:${PORT}${MCP_PATH}`);
});

