// ABOUTME: Drizzle schema for the drops app, including browser sessions and revocable CLI credentials.
// ABOUTME: Composite FK drops.current_version -> drop_versions(id, drop_id) is added by a raw SQL step in the migration.
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgTable, text, uuid, bigint, integer, boolean, timestamp, uniqueIndex, index, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const allowedEmails = pgTable('allowed_emails', {
  email: text('email').primaryKey(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  email: text('email').notNull().unique(),
  username: text('username'),
  kind: text('kind').notNull().default('member'),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  usernameUnique: uniqueIndex('users_username_unique').on(t.username).where(sql`${t.username} IS NOT NULL`),
  kindCheck: check('users_kind_check', sql`${t.kind} IN ('member','viewer')`),
}));

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const cliAuthorizationCodes = pgTable('cli_authorization_codes', {
  codeHash: text('code_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (t) => ({
  expiryIdx: index('cli_authorization_codes_expires_at_idx').on(t.expiresAt),
}));

export const cliTokens = pgTable('cli_tokens', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  userRevocationIdx: index('cli_tokens_user_id_revoked_at_idx').on(t.userId, t.revokedAt),
}));

export const pendingLogins = pgTable('pending_logins', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const drops = pgTable('drops', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  currentVersion: uuid('current_version'),
  viewMode: text('view_mode').notNull().default('authed'),
  includeDomain: boolean('include_domain').notNull().default(false),
  folderId: uuid('folder_id').references((): AnyPgColumn => folders.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ownerNameUnique: uniqueIndex('drops_owner_name_unique').on(t.ownerId, t.name),
  viewModeCheck: check('drops_view_mode_check', sql`${t.viewMode} IN ('authed','public','emails')`),
  folderIdx: index('drops_folder_id_idx').on(t.folderId),
}));

export const dropVersions = pgTable('drop_versions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  dropId: uuid('drop_id').notNull().references(() => drops.id, { onDelete: 'cascade' }),
  r2Prefix: text('r2_prefix').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  fileCount: integer('file_count').notNull(),
  entryPath: text('entry_path'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idDropUnique: uniqueIndex('drop_versions_id_drop_unique').on(t.id, t.dropId),
}));

export const dropViewers = pgTable('drop_viewers', {
  dropId: uuid('drop_id').notNull().references(() => drops.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.dropId, t.email] }),
  emailIdx: index('drop_viewers_email_idx').on(t.email),
}));

export const magicLinkTokens = pgTable('magic_link_tokens', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  dropId: uuid('drop_id').notNull().references(() => drops.id, { onDelete: 'cascade' }),
  next: text('next').notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  liveLookupIdx: index('magic_link_tokens_email_drop_idx').on(t.email, t.dropId),
}));

export const folders = pgTable('folders', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => folders.id, { onDelete: 'restrict' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  noSelfParent: check('folders_no_self_parent', sql`${t.id} <> ${t.parentId}`),
  siblingUniqueNamed: uniqueIndex('folders_sibling_name_unique')
    .on(t.parentId, t.name).where(sql`${t.parentId} IS NOT NULL`),
  rootUniqueNamed: uniqueIndex('folders_root_name_unique')
    .on(t.name).where(sql`${t.parentId} IS NULL`),
}));
