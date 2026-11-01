/** Internal control tools exposed only between the plugin and its native host. */

export const ARM_EXISTING_PROFILE_GRANT = '__dsh_arm_existing_profile_grant'
export const CLEAR_EXISTING_PROFILE_GRANT = '__dsh_clear_existing_profile_grant'

export const NATIVE_HOST_INTERNAL_TOOLS: readonly string[] = [
  ARM_EXISTING_PROFILE_GRANT,
  CLEAR_EXISTING_PROFILE_GRANT,
]

export function isNativeHostInternalTool(name: string): boolean {
  return NATIVE_HOST_INTERNAL_TOOLS.includes(name)
}
