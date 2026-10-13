let configs = null;

/**
 * Reads the view options the host injects as JSON into
 * <script type="application/json" id="office-configs"> (never executed under the CSP).
 */
export function getConfigs() {
    if (configs) return configs;
    const value = document.getElementById('office-configs')?.textContent?.trim();
    if (!value || value == '{{configs}}') return null;
    try {
        configs = JSON.parse(value);
    } catch {
        return null;
    }
    return configs;
}
