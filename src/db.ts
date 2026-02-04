import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";

export type DbUser = {
  id: string;
  auth_provider_id: string;
  handle: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
};

export type ListSummary = {
  id: string;
  owner_id: string;
  title: string;
  type: string;
  visibility: string;
  active_count: number;
  done_count: number;
  owner_handle: string;
  owner_display_name: string | null;
};

export type ItemRow = {
  id: string;
  list_id: string;
  title: string;
  note: string | null;
  url: string | null;
  status: "active" | "done";
  order_index: number;
  created_at: string;
};

const sslEnabled = process.env.DATABASE_SSL === "true";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
});

export async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function getUserByAuthProviderId(authProviderId: string): Promise<DbUser | null> {
  const rows = await query<DbUser>(
    "select * from users where auth_provider_id = $1",
    [authProviderId]
  );
  return rows[0] ?? null;
}

export async function getUserById(userId: string): Promise<DbUser | null> {
  const rows = await query<DbUser>("select * from users where id = $1", [userId]);
  return rows[0] ?? null;
}

export async function ensureUser(params: {
  authProviderId: string;
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}): Promise<DbUser> {
  async function resolveHandle(base: string) {
    let candidate = base;
    const existing = await query<{ auth_provider_id: string }>(
      "select auth_provider_id from users where handle = $1",
      [candidate]
    );
    if (existing.length === 0 || existing[0].auth_provider_id === params.authProviderId) {
      return candidate;
    }
    const suffix = Math.floor(Math.random() * 9000 + 1000);
    candidate = `${base}_${suffix}`;
    return candidate;
  }

  const safeHandle = await resolveHandle(params.handle);
  const existing = await getUserByAuthProviderId(params.authProviderId);
  if (existing) {
    const updates: string[] = [];
    const values: unknown[] = [];
    if (params.displayName !== undefined && params.displayName !== existing.display_name) {
      values.push(params.displayName);
      updates.push(`display_name = $${values.length}`);
    }
    if (params.avatarUrl !== undefined && params.avatarUrl !== existing.avatar_url) {
      values.push(params.avatarUrl);
      updates.push(`avatar_url = $${values.length}`);
    }
    if (safeHandle !== existing.handle) {
      values.push(safeHandle);
      updates.push(`handle = $${values.length}`);
    }
    if (updates.length > 0) {
      values.push(existing.id);
      await query("update users set " + updates.join(", ") + " where id = $" + values.length, values);
    }
    return (await getUserByAuthProviderId(params.authProviderId)) as DbUser;
  }

  const id = uuidv4();
  await query(
    "insert into users (id, auth_provider_id, handle, display_name, avatar_url) values ($1, $2, $3, $4, $5)",
    [id, params.authProviderId, safeHandle, params.displayName ?? null, params.avatarUrl ?? null]
  );
  return (await getUserById(id)) as DbUser;
}

export async function listUserSummaries(): Promise<DbUser[]> {
  return query<DbUser>("select * from users order by created_at desc");
}

export async function searchUsersByQuery(queryText: string): Promise<DbUser[]> {
  const q = `%${queryText.toLowerCase()}%`;
  return query<DbUser>(
    "select * from users where lower(handle) like $1 or lower(display_name) like $1 order by created_at desc limit 20",
    [q]
  );
}

export async function getListsByOwner(ownerId: string): Promise<ListSummary[]> {
  return query<ListSummary>(
    `select
      l.id,
      l.owner_id,
      l.title,
      l.type,
      l.visibility,
      coalesce(sum(case when i.status = 'active' then 1 else 0 end), 0)::int as active_count,
      coalesce(sum(case when i.status = 'done' then 1 else 0 end), 0)::int as done_count,
      u.handle as owner_handle,
      u.display_name as owner_display_name
    from lists l
    left join items i on i.list_id = l.id
    join users u on u.id = l.owner_id
    where l.owner_id = $1
    group by l.id, l.owner_id, l.title, l.type, l.visibility, u.handle, u.display_name
    order by l.created_at desc`,
    [ownerId]
  );
}

export async function getListSummaryById(listId: string): Promise<ListSummary | null> {
  const rows = await query<ListSummary>(
    `select
      l.id,
      l.owner_id,
      l.title,
      l.type,
      l.visibility,
      coalesce(sum(case when i.status = 'active' then 1 else 0 end), 0)::int as active_count,
      coalesce(sum(case when i.status = 'done' then 1 else 0 end), 0)::int as done_count,
      u.handle as owner_handle,
      u.display_name as owner_display_name
    from lists l
    left join items i on i.list_id = l.id
    join users u on u.id = l.owner_id
    where l.id = $1
    group by l.id, l.owner_id, l.title, l.type, l.visibility, u.handle, u.display_name`,
    [listId]
  );
  return rows[0] ?? null;
}

export async function getListById(listId: string) {
  const rows = await query<{
    id: string;
    owner_id: string;
    title: string;
    type: string;
    visibility: string;
  }>("select id, owner_id, title, type, visibility from lists where id = $1", [listId]);
  return rows[0] ?? null;
}

export async function createList(params: {
  ownerId: string;
  title: string;
  type: string;
}): Promise<string> {
  const id = uuidv4();
  await query(
    "insert into lists (id, owner_id, title, type, visibility) values ($1, $2, $3, $4, 'public')",
    [id, params.ownerId, params.title, params.type]
  );
  return id;
}

export async function addItem(params: {
  listId: string;
  title: string;
  note?: string | null;
  url?: string | null;
}): Promise<string> {
  const id = uuidv4();
  await query(
    "insert into items (id, list_id, title, note, url, status, order_index) values ($1, $2, $3, $4, $5, 'active', 0)",
    [id, params.listId, params.title, params.note ?? null, params.url ?? null]
  );
  return id;
}

export async function updateItem(params: {
  itemId: string;
  listId: string;
  title?: string;
  note?: string | null;
  url?: string | null;
}): Promise<void> {
  const updates: string[] = [];
  const values: unknown[] = [];
  if (params.title !== undefined) {
    values.push(params.title);
    updates.push(`title = $${values.length}`);
  }
  if (params.note !== undefined) {
    values.push(params.note);
    updates.push(`note = $${values.length}`);
  }
  if (params.url !== undefined) {
    values.push(params.url);
    updates.push(`url = $${values.length}`);
  }
  if (updates.length === 0) {
    return;
  }
  values.push(params.itemId, params.listId);
  const itemIdIndex = values.length - 1;
  const listIdIndex = values.length;
  await query(
    `update items set ${updates.join(", ")}, updated_at = now() where id = $${itemIdIndex} and list_id = $${listIdIndex}`,
    values
  );
}

export async function setItemStatus(params: {
  itemId: string;
  listId: string;
  status: "active" | "done";
}): Promise<void> {
  await query(
    "update items set status = $1, updated_at = now() where id = $2 and list_id = $3",
    [params.status, params.itemId, params.listId]
  );
}

export async function getItemsByList(listId: string, status: "active" | "done"): Promise<ItemRow[]> {
  return query<ItemRow>(
    "select id, list_id, title, note, url, status, order_index, created_at from items where list_id = $1 and status = $2 order by created_at desc",
    [listId, status]
  );
}

export async function createBookmark(params: {
  userId: string;
  sourceItemId: string;
  sourceListId: string;
  sourceUserId: string;
  createdItemId: string;
}): Promise<void> {
  const id = uuidv4();
  await query(
    "insert into bookmarks (id, user_id, source_item_id, source_list_id, source_user_id, created_item_id) values ($1, $2, $3, $4, $5, $6)",
    [
      id,
      params.userId,
      params.sourceItemId,
      params.sourceListId,
      params.sourceUserId,
      params.createdItemId,
    ]
  );
}

export async function findSourceItem(sourceItemId: string) {
  const rows = await query<{
    id: string;
    title: string;
    note: string | null;
    url: string | null;
    list_id: string;
    list_title: string;
    list_type: string;
    owner_id: string;
    owner_handle: string;
  }>(
    `select i.id, i.title, i.note, i.url, i.list_id, l.title as list_title, l.type as list_type, l.owner_id, u.handle as owner_handle
     from items i
     join lists l on l.id = i.list_id
     join users u on u.id = l.owner_id
     where i.id = $1`,
    [sourceItemId]
  );
  return rows[0] ?? null;
}

export async function getOrCreateListByType(params: {
  ownerId: string;
  type: string;
  fallbackTitle: string;
}): Promise<string> {
  const rows = await query<{ id: string }>(
    "select id from lists where owner_id = $1 and type = $2 order by created_at desc limit 1",
    [params.ownerId, params.type]
  );
  if (rows[0]) {
    return rows[0].id;
  }
  return createList({ ownerId: params.ownerId, title: params.fallbackTitle, type: params.type });
}
