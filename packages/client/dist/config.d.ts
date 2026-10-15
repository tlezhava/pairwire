export type Delivery = "auto" | "pull";
export interface Config {
    /** Display name for HELLO; `null` = derive it with resolveDisplayName(). */
    name: string | null;
    /** Relay host[:port] for rooms this client starts; `null` = the built-in default. */
    relay: string | null;
    autoContinue: boolean;
    hopBudget: number;
    delivery: Delivery;
    channels: boolean;
}
export declare const DEFAULT_CONFIG: Config;
export declare class ConfigError extends Error {
    readonly name = "ConfigError";
}
export interface LoadedConfig {
    config: Config;
    /** Problems that don't stop the client, such as unknown keys. */
    warnings: string[];
}
/** Reads `<home>/config.json` (all keys optional) and applies the environment overrides. */
export declare function loadConfig(home: string, env?: NodeJS.ProcessEnv): LoadedConfig;
/** The configured name, else `git config user.name`, else `$USER`, else "anonymous". */
export declare function resolveDisplayName(config: Config, cwd: string, env?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=config.d.ts.map