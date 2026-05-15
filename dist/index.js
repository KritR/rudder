#!/usr/bin/env node
import { main } from "./main.js";
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`rudder: ${message}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map