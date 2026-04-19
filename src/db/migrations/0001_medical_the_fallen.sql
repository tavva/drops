CREATE TABLE "drop_viewers" (
	"drop_id" uuid NOT NULL,
	"email" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drop_viewers_drop_id_email_pk" PRIMARY KEY("drop_id","email")
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_username_unique";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "view_mode" text DEFAULT 'authed' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "drop_viewers" ADD CONSTRAINT "drop_viewers_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drop_viewers_email_idx" ON "drop_viewers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree ("username") WHERE "users"."username" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "drops" ADD CONSTRAINT "drops_view_mode_check" CHECK ("drops"."view_mode" IN ('authed','public','emails'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_check" CHECK ("users"."kind" IN ('member','viewer'));