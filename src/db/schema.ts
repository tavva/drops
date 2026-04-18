// ABOUTME: Drizzle schema for the drops app: users, sessions, pending logins, drops, drop versions.
// ABOUTME: Composite FK drops.current_version -> drop_versions(id, drop_id) is added by a raw SQL step in the migration.
import { pgTable, text, uuid, bigint, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const allowedEmails = pgTable('allowed_emails', {
  email: text('email').primaryKey(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  email: text('email').notNull().unique(),
  username: text('username').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ownerNameUnique: uniqueIndex('drops_owner_name_unique').on(t.ownerId, t.name),
}));

export const dropVersions = pgTable('drop_versions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  dropId: uuid('drop_id').notNull().references(() => drops.id, { onDelete: 'cascade' }),
  r2Prefix: text('r2_prefix').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  fileCount: integer('file_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idDropUnique: uniqueIndex('drop_versions_id_drop_unique').on(t.id, t.dropId),
}));
