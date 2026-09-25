/**
 * Hardware detection tap.
 *
 * The OS-enumerated GPU is frequently a virtual display adapter on Windows and
 * never reflects which device PyTorch actually selected for compute. ComfyUI's
 * own startup logs are the authoritative source: they print the selected
 * accelerator, its VRAM, and the torch build. We tail that output, already
 * piped through `proc.stdout` / `proc.stderr` in `sessionActions/launch.ts`,
 * and expose the result via `getAcceleratorInfo()` for local features (the
 * performance-test workflows). Nothing here leaves the machine.
 *
 * Log strings parsed (current ComfyUI main branch):
 *   - "Device: cuda:0 NVIDIA GeForce RTX 4090 : native"   (model_management.py)
 *   - "Total VRAM 24576 MB, total RAM 65461 MB"
 *   - "pytorch version: 2.10.0+cu130" / "xformers version: 0.0.x"
 *   - "Set cuda device to: 0"                              (main.py)
 *   - "Using directml with device: AMD Radeon RX 6800"     (model_management.py)
 *   - "Device: cuda:0 ..." / "xpu:0 ..." / "npu:0 ..." / "mlu:0 ..." / "cpu" / "mps"
 *
 * NOTE: ComfyUI Desktop's bundled build prefixes every log line with a level
 * tag (`[INFO] Device: ...`), unlike the bare `%(message)s` format. `handleLine`
 * strips a leading `[LEVEL] ` tag before matching so both formats parse.
 */
import { createStreamLineBuffer, stripAnsi, stripLogLevelPrefix } from './stderrTail'
import type { AcceleratorInfo, AcceleratorSnapshot } from '../../types/ipc'

export type { AcceleratorInfo, AcceleratorSnapshot } from '../../types/ipc'

const DEVICE_LINE = /^Device:\s*(.+)$/
const VRAM_LINE = /^Total VRAM\s+(\d+)\s*MB,\s*total RAM\s+(\d+)\s*MB/i
const PYTORCH_LINE = /^pytorch version:\s*(.+)$/i
const XFORMERS_LINE = /^xformers version:\s*(.+)$/i
const CUDA_DEVICE_LINE = /^Set cuda device to:\s*(\d+)/i
// DirectML (AMD/Intel on Windows without ROCm) logs the GPU name here, on a
// separate line that precedes a nameless `Device: privateuseone` line, so it's
// the only way to recover the model for those vendors.
const DIRECTML_LINE = /^Using directml with device:\s*(.+)$/i

/**
 * Parse a ComfyUI `Device:` line into its components. Handles the cuda
 * format (`cuda:0 <name> : <backend>`), the xpu/npu/mlu format
 * (`<type>:<index> <name>`), the bare-type format (`cpu` / `mps`), and the
 * legacy fallback format (`CUDA cuda:0: <name>`). Returns null for a
 * non-device line.
 */
export function parseDeviceLine(line: string): AcceleratorInfo | null {
  const m = line.match(DEVICE_LINE)
  if (!m || !m[1]) return null
  let rest = m[1].trim()
  // Legacy fallback "CUDA cuda:0: <name>": drop the leading "CUDA ".
  if (/^CUDA\s+/i.test(rest)) rest = rest.replace(/^CUDA\s+/i, '')
  const tok = rest.match(/^([A-Za-z][A-Za-z0-9]*)(?::(\d+))?/)
  if (!tok || !tok[1]) return null
  const deviceType = tok[1].toLowerCase()
  const deviceIndex = tok[2] != null ? Number(tok[2]) : null
  // Strip the device token, then a stray leading ":" (legacy fallback's
  // "cuda:0: <name>" leaves ": <name>").
  const remainder = rest.slice(tok[0].length).trim().replace(/^:\s*/, '')
  let deviceName: string | null = remainder || null
  let backend: string | null = null
  // The cuda format appends " : <backend>" (e.g. native / cudaMallocAsync).
  const sep = remainder.lastIndexOf(' : ')
  if (sep >= 0) {
    deviceName = remainder.slice(0, sep).trim() || null
    backend = remainder.slice(sep + 3).trim() || null
  }
  return { deviceType, deviceIndex, deviceName, backend }
}

/** Parse "Total VRAM X MB, total RAM Y MB" into MB numbers, or null. */
export function parseVramLine(line: string): { vramMb: number; ramMb: number } | null {
  const m = line.match(VRAM_LINE)
  if (!m || !m[1] || !m[2]) return null
  return { vramMb: Number(m[1]), ramMb: Number(m[2]) }
}

/** Extract the value after a `key: value` style line via the given regex. */
function parseTail(line: string, re: RegExp): string | null {
  const m = line.match(re)
  return m && m[1] ? m[1].trim() : null
}

/** Cap on devices retained per boot, so a malformed log can't grow the array. */
const MAX_DEVICES = 16

export function createHardwareTap(): {
  ingest: (chunk: string, source: 'stdout' | 'stderr') => void
  beginBoot: () => void
  getAcceleratorInfo: () => AcceleratorSnapshot | null
} {
  // Accelerator accumulation: fields trickle in over several lines. ComfyUI
  // logs the selected device first, then one `Device:` line per other GPU. The
  // consecutive run of `Device:` lines is closed by the first non-`Device:`
  // line, after which the snapshot is settled for this boot.
  let acceleratorSettled = false
  let vramMb: number | null = null
  let ramMb: number | null = null
  let pytorchVersion: string | null = null
  let xformersVersion: string | null = null
  let cudaDeviceSet: number | null = null
  let directmlDeviceName: string | null = null
  const devices: AcceleratorInfo[] = []

  function getAcceleratorInfo(): AcceleratorSnapshot | null {
    if (devices.length === 0) return null
    const primary = devices[0]!
    // DirectML logs a nameless `Device: privateuseone`; recover the model from
    // the earlier `Using directml with device:` line (never for cpu/mps).
    const primaryName =
      primary.deviceName ??
      (primary.deviceType !== 'cpu' && primary.deviceType !== 'mps' ? directmlDeviceName : null)
    return {
      ...primary,
      deviceName: primaryName,
      devices: devices.map((device, index) => ({
        ...device,
        deviceName: index === 0 ? primaryName : device.deviceName
      })),
      vramMb,
      ramMb,
      pytorchVersion,
      xformersVersion,
      cudaDeviceSet
    }
  }

  function handleLine(line: string): void {
    if (acceleratorSettled) return
    // Strip a leading `[LEVEL] ` tag (ComfyUI Desktop's bundled build) so the
    // anchored parsers below match both the prefixed and bare log formats.
    const trimmed = stripLogLevelPrefix(stripAnsi(line).trim())
    if (trimmed.length === 0) return

    const vram = parseVramLine(trimmed)
    if (vram) {
      vramMb = vram.vramMb
      ramMb = vram.ramMb
      return
    }
    const pytorch = parseTail(trimmed, PYTORCH_LINE)
    if (pytorch) {
      pytorchVersion = pytorch
      return
    }
    const xformers = parseTail(trimmed, XFORMERS_LINE)
    if (xformers) {
      xformersVersion = xformers
      return
    }
    const cudaDevice = parseTail(trimmed, CUDA_DEVICE_LINE)
    if (cudaDevice) {
      cudaDeviceSet = Number(cudaDevice)
      return
    }
    const directml = parseTail(trimmed, DIRECTML_LINE)
    if (directml) {
      directmlDeviceName = directml
      return
    }
    const device = parseDeviceLine(trimmed)
    if (device) {
      if (devices.length < MAX_DEVICES) devices.push(device)
      return
    }
    if (devices.length > 0) acceleratorSettled = true
  }

  const lineBuffer = createStreamLineBuffer()

  return {
    ingest(chunk: string, source: 'stdout' | 'stderr'): void {
      // Hard guarantee: this runs inside the launch stdout/stderr handler,
      // right before the boot-progress tracker. A throw here must never break
      // log streaming or boot detection.
      for (const line of lineBuffer.append(source, chunk)) {
        try {
          handleLine(line)
        } catch {
          // Isolate malformed lines.
        }
      }
    },
    /**
     * Reset per-boot accelerator accumulation. A single launch can restart
     * ComfyUI several times (port/reboot retries, model-folder relaunch,
     * Manager restarts), each reusing this tap. Without this, stale fields from
     * the first boot would be reported for later boots.
     */
    beginBoot(): void {
      acceleratorSettled = false
      vramMb = null
      ramMb = null
      pytorchVersion = null
      xformersVersion = null
      cudaDeviceSet = null
      directmlDeviceName = null
      devices.length = 0
      // Drop any incomplete lines from the previous (now-dead) process streams.
      lineBuffer.reset()
    },
    getAcceleratorInfo
  }
}
