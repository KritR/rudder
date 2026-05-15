import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const nativeBinaryName = "rudder-native";
export function resolveNativeBinaryPath() {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.resolve(moduleDir, "native", nativeBinaryName),
        path.resolve(moduleDir, "..", "target", "release", nativeBinaryName),
        path.resolve(moduleDir, "..", "native", "target", "release", nativeBinaryName),
    ];
    for (const candidate of candidates) {
        if (isExecutableFile(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
function isExecutableFile(file) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=native-binary.js.map