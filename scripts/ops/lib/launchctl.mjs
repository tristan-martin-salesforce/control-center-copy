// The one launchctl every ops script calls. CC_LAUNCHCTL points it at a stand-in (a test's fake, the onboarding dry
// run's process starter): with CC_LAUNCH_AGENTS_DIR moved to a scratch folder, a real /bin/launchctl would still
// load, stop or restart this Mac's real com.commandcenter.* services, because launchd knows them by label.

/** @param {Record<string, string | undefined>} [env] */
export const launchctlBin = (env = process.env) => env.CC_LAUNCHCTL || '/bin/launchctl';
