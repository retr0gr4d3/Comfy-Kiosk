import { describe, it, expect } from 'vitest'
import { createHardwareTap, parseDeviceLine, parseVramLine } from './hardwareTap'

describe('parseDeviceLine', () => {
  it('parses the cuda format with backend suffix', () => {
    expect(parseDeviceLine('Device: cuda:0 NVIDIA GeForce RTX 4090 : native')).toEqual({
      deviceType: 'cuda',
      deviceIndex: 0,
      deviceName: 'NVIDIA GeForce RTX 4090',
      backend: 'native'
    })
  })

  it('parses the cudaMallocAsync backend', () => {
    expect(parseDeviceLine('Device: cuda:1 NVIDIA RTX A6000 : cudaMallocAsync')).toMatchObject({
      deviceIndex: 1,
      deviceName: 'NVIDIA RTX A6000',
      backend: 'cudaMallocAsync'
    })
  })

  it('parses the legacy "CUDA cuda:0: name" fallback format', () => {
    expect(parseDeviceLine('Device: CUDA cuda:0: NVIDIA GeForce GTX 1080')).toEqual({
      deviceType: 'cuda',
      deviceIndex: 0,
      deviceName: 'NVIDIA GeForce GTX 1080',
      backend: null
    })
  })

  it('parses the xpu format without a backend suffix', () => {
    expect(parseDeviceLine('Device: xpu:0 Intel(R) Arc(TM) A770 Graphics')).toEqual({
      deviceType: 'xpu',
      deviceIndex: 0,
      deviceName: 'Intel(R) Arc(TM) A770 Graphics',
      backend: null
    })
  })

  it('parses bare device types (cpu / mps)', () => {
    expect(parseDeviceLine('Device: cpu')).toEqual({
      deviceType: 'cpu',
      deviceIndex: null,
      deviceName: null,
      backend: null
    })
    expect(parseDeviceLine('Device: mps')).toMatchObject({ deviceType: 'mps', deviceName: null })
  })

  it('returns null for non-device lines', () => {
    expect(parseDeviceLine('Total VRAM 24576 MB, total RAM 65461 MB')).toBeNull()
    expect(parseDeviceLine('')).toBeNull()
  })
})

describe('parseVramLine', () => {
  it('parses VRAM/RAM amounts', () => {
    expect(parseVramLine('Total VRAM 24576 MB, total RAM 65461 MB')).toEqual({
      vramMb: 24576,
      ramMb: 65461
    })
    expect(parseVramLine('nope')).toBeNull()
  })
})

describe('createHardwareTap', () => {
  it('collects the whole Device run, merging earlier metadata lines', () => {
    const tap = createHardwareTap()
    tap.ingest('Set cuda device to: 0\n', 'stdout')
    tap.ingest('Total VRAM 24576 MB, total RAM 65461 MB\n', 'stdout')
    tap.ingest('pytorch version: 2.10.0+cu130\n', 'stdout')
    tap.ingest('xformers version: 0.0.31\n', 'stdout')
    tap.ingest('Device: cuda:0 NVIDIA GeForce RTX 4090 : native\n', 'stdout')
    // A second Device line (other GPU) belongs to the SAME run.
    tap.ingest('Device: cuda:1 NVIDIA GeForce RTX 5090 : native\n', 'stdout')
    tap.ingest('Using xformers attention\n', 'stdout')

    expect(tap.getAcceleratorInfo()).toEqual({
      deviceType: 'cuda',
      deviceIndex: 0,
      deviceName: 'NVIDIA GeForce RTX 4090',
      backend: 'native',
      devices: [
        {
          deviceType: 'cuda',
          deviceIndex: 0,
          deviceName: 'NVIDIA GeForce RTX 4090',
          backend: 'native'
        },
        {
          deviceType: 'cuda',
          deviceIndex: 1,
          deviceName: 'NVIDIA GeForce RTX 5090',
          backend: 'native'
        }
      ],
      vramMb: 24576,
      ramMb: 65461,
      pytorchVersion: '2.10.0+cu130',
      xformersVersion: '0.0.31',
      cudaDeviceSet: 0
    })
  })

  it('returns null before any Device line is seen', () => {
    const tap = createHardwareTap()
    tap.ingest('Total VRAM 24576 MB, total RAM 65461 MB\n', 'stdout')
    expect(tap.getAcceleratorInfo()).toBeNull()
  })

  it('parses current ComfyUI log lines carrying a colored [LEVEL] prefix', () => {
    // ComfyUI's ColoredFormatter emits `\x1b[32m[INFO]\x1b[0m <message>`, not
    // the bare `%(message)s` the parsers are anchored against. The tap must
    // strip ANSI then the level tag.
    const tap = createHardwareTap()
    tap.ingest('\u001b[32m[INFO]\u001b[0m Total VRAM 32607 MB, total RAM 97430 MB\n', 'stdout')
    tap.ingest('\u001b[32m[INFO]\u001b[0m pytorch version: 2.10.0+cu130\n', 'stdout')
    tap.ingest(
      '\u001b[32m[INFO]\u001b[0m Device: cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync\n',
      'stdout'
    )
    tap.ingest('\u001b[32m[INFO]\u001b[0m Using xformers attention\n', 'stdout')

    expect(tap.getAcceleratorInfo()).toMatchObject({
      deviceType: 'cuda',
      deviceIndex: 0,
      deviceName: 'NVIDIA GeForce RTX 5090',
      backend: 'cudaMallocAsync',
      vramMb: 32607,
      pytorchVersion: '2.10.0+cu130'
    })
  })

  it('detects a complete Device line even in an oversized chunk', () => {
    // A single large stdout chunk: complete metadata + Device lines, then a
    // huge unterminated tail. The buffer cap must only trim the tail, never
    // drop the complete lines that precede it.
    const tap = createHardwareTap()
    const hugeTail = 'x'.repeat(64 * 1024)
    tap.ingest(
      'Total VRAM 24576 MB, total RAM 65461 MB\n' +
        'Device: cuda:0 NVIDIA GeForce RTX 4090 : native\n' +
        'startup continues\n' +
        hugeTail,
      'stdout'
    )

    expect(tap.getAcceleratorInfo()).toMatchObject({
      deviceName: 'NVIDIA GeForce RTX 4090',
      vramMb: 24576
    })
  })

  it('recovers the DirectML GPU name from the separate "Using directml" line', () => {
    const tap = createHardwareTap()
    tap.ingest('Using directml with device: AMD Radeon RX 6800\n', 'stdout')
    tap.ingest('Total VRAM 16384 MB, total RAM 32768 MB\n', 'stdout')
    tap.ingest('Device: privateuseone\n', 'stdout')
    expect(tap.getAcceleratorInfo()).toMatchObject({
      deviceType: 'privateuseone',
      deviceName: 'AMD Radeon RX 6800'
    })
  })

  it('never borrows the DirectML name for a cpu device', () => {
    const tap = createHardwareTap()
    tap.ingest('Using directml with device: AMD Radeon RX 6800\n', 'stdout')
    tap.ingest('Device: cpu\n', 'stdout')
    expect(tap.getAcceleratorInfo()).toMatchObject({ deviceType: 'cpu', deviceName: null })
  })

  it('reports non-cuda accelerators (Intel xpu)', () => {
    const tap = createHardwareTap()
    tap.ingest('Total VRAM 16384 MB, total RAM 32768 MB\n', 'stdout')
    tap.ingest('Device: xpu:0 Intel(R) Arc(TM) A770 Graphics\n', 'stdout')
    expect(tap.getAcceleratorInfo()).toMatchObject({
      deviceType: 'xpu',
      deviceIndex: 0,
      deviceName: 'Intel(R) Arc(TM) A770 Graphics'
    })
  })

  it('ignores stale Device lines after the run closes, and resets on beginBoot', () => {
    const tap = createHardwareTap()
    tap.ingest('Total VRAM 24576 MB, total RAM 65461 MB\n', 'stdout')
    tap.ingest('Device: cuda:0 NVIDIA GeForce RTX 4090 : native\n', 'stdout')
    tap.ingest('startup continues\n', 'stdout') // closes the run

    // A stale Device line after the run closed must not join it.
    tap.ingest('Device: cuda:1 NVIDIA GeForce RTX 5090 : native\n', 'stdout')
    expect(tap.getAcceleratorInfo()?.devices).toHaveLength(1)

    tap.beginBoot()
    expect(tap.getAcceleratorInfo()).toBeNull()
    tap.ingest('Total VRAM 16384 MB, total RAM 32768 MB\n', 'stdout')
    tap.ingest('Device: cuda:0 NVIDIA GeForce RTX 4080 : native\n', 'stdout')
    expect(tap.getAcceleratorInfo()).toMatchObject({
      deviceName: 'NVIDIA GeForce RTX 4080',
      vramMb: 16384
    })
  })

  it('handles lines split across chunk boundaries', () => {
    const tap = createHardwareTap()
    tap.ingest('Device: cuda:0 NVIDIA GeForce ', 'stdout')
    tap.ingest('RTX 4090 : native\n', 'stdout')
    expect(tap.getAcceleratorInfo()).toMatchObject({ deviceName: 'NVIDIA GeForce RTX 4090' })
  })

  it('keeps stdout and stderr partial lines from splicing together', () => {
    const tap = createHardwareTap()
    // Interleaved partial lines from two streams must not be concatenated into
    // a bogus combined line; each stream's buffer completes independently.
    tap.ingest('Device: cuda:0 NVIDIA GeForce ', 'stdout')
    tap.ingest('some unrelated stderr noise\n', 'stderr')
    tap.ingest('RTX 4090 : native\n', 'stdout')
    expect(tap.getAcceleratorInfo()).toMatchObject({ deviceName: 'NVIDIA GeForce RTX 4090' })
  })
})
