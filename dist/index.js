#!/usr/bin/env node
import { main } from "./main.js";
import { MissingToolError } from "./util.js";
main().catch((error) => {
    if (error instanceof MissingToolError) {
        console.error(error.message);
        process.exit(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`rudder: ${message}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map