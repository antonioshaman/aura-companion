import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Re-export Better Auth tables so Drizzle's fullSchema includes them.
export * from "./auth-schema.js";

// ─── Organization Billing ────────────────────────────────────────────────────
// Links Stripe billing to a Better Auth organization.
// Better Auth manages the organization/member/team tables; this table adds the
// billing fields that Better Auth doesn't provide.

export const organizationBilling = pgTable("organization_billing", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").unique().notNull(),
  stripeCustomerId: text("stripe_customer_id").unique(),
  plan: text("plan").notNull().default("starter"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ─── Instances ───────────────────────────────────────────────────────────────
// Each instance belongs to an organization. It can be shared (all org members
// can access) or personal (only the owner can access).
//
// organizationId and ownerId reference Better Auth-managed tables by text ID.
// No Drizzle FK constraints on those — they are separate table systems.

//
// Provisioning lifecycle: a row is inserted with machineStatus="provisioning"
// BEFORE any Hetzner resource is created, so the row (and its id, which is
// stamped on the Hetzner resources as the `instance` label) is the durable
// record the orphan reconciler checks against.
//
// idempotencyKey: optional client-supplied `Idempotency-Key`, unique per org,
// so a retried create returns the existing row instead of a second server.
//
// bootstrapTokenHash/bootstrapTokenExpiresAt: sha256 of the one-time token
// placed in cloud-init user_data. The instance exchanges it once (POST
// /api/instance-bootstrap) for its real secrets; both columns are nulled on
// use so the token cannot be replayed.

export const instances = pgTable("instances", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  ownerId: text("owner_id"), // null = shared instance
  ownerType: text("owner_type").notNull().default("shared"), // "shared" | "personal"
  // Keep legacy SQL column names for backward compatibility with existing DBs.
  // Property names are provider-neutral in application code.
  providerMachineId: text("fly_machine_id").unique(),
  providerVolumeId: text("fly_volume_id"),
  region: text("region").notNull().default("iad"),
  hostname: text("hostname").unique(),
  customDomain: text("custom_domain"),
  machineStatus: text("machine_status").notNull().default("provisioning"),
  authSecret: text("auth_secret").notNull(),
  config: jsonb("config").default({}),
  tailscaleEnabled: boolean("tailscale_enabled").default(false),
  tailscaleHostname: text("tailscale_hostname"),
  hasActiveCrons: boolean("has_active_crons").default(false),
  idempotencyKey: text("idempotency_key"),
  bootstrapTokenHash: text("bootstrap_token_hash").unique(),
  bootstrapTokenExpiresAt: timestamp("bootstrap_token_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("instances_org_idempotency_key_uidx").on(table.organizationId, table.idempotencyKey),
]);

// ─── Instance Events (audit log) ─────────────────────────────────────────────

export const instanceEvents = pgTable("instance_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  instanceId: uuid("instance_id")
    .references(() => instances.id, { onDelete: "cascade" })
    .notNull(),
  eventType: text("event_type").notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ─── Subscriptions ───────────────────────────────────────────────────────────
// Subscriptions are scoped to organizations, not individual users.

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id").unique().notNull(),
  plan: text("plan").notNull(),
  status: text("status").notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
