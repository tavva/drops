CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_no_self_parent" CHECK ("folders"."id" <> "folders"."parent_id")
);
--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_sibling_name_unique" ON "folders" USING btree ("parent_id","name") WHERE "folders"."parent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_root_name_unique" ON "folders" USING btree ("name") WHERE "folders"."parent_id" IS NULL;--> statement-breakpoint
ALTER TABLE "drops" ADD CONSTRAINT "drops_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drops_folder_id_idx" ON "drops" USING btree ("folder_id");