// Prints the newest captures from the local Sirna database (dev helper).
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const path = join(process.env.APPDATA ?? "", "dev.sirna.app", "sirna.db");
const db = new DatabaseSync(path, { readOnly: true });
console.log(
  db
    .prepare("SELECT id, source, body, parse_status FROM core_raw_items ORDER BY id DESC LIMIT 5")
    .all(),
);
