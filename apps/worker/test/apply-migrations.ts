import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { installDoh } from "./doh.ts";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
installDoh();
