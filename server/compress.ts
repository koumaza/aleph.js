export const deno_x_brotli = 'https://raw.githubusercontent.com/denosaurs/deno_brotli/master/mod.ts'
export const deno_x_flate = 'https://raw.githubusercontent.com/hazae41/denoflate/master/mod.ts'

class Compression {
  #brotli: ((data: Uint8Array) => Uint8Array) | null = null
  #gzip: ((data: Uint8Array) => Uint8Array) | null = null
  #enable: boolean = false

  async enable() {
    this.#enable = true
  }

  accept(acceptEncoding: string, contentType: string, contentLength: number): 'br' | 'gzip' | null {
    const shouldCompress = this.#enable && (
      contentType.startsWith('text/') ||
      /^application\/(javascript|json|xml|wasm)/i.test(contentType) ||
      /^image\/svg\+xml/i.test(contentType)
    )
    if (shouldCompress && contentLength > 1024) {
      if (acceptEncoding.includes('br')) {
        return 'br'
      } else if (acceptEncoding.includes('gzip')) {
        return 'gzip'
      }
    }
    return null
  }

  async compress(
    data: Uint8Array,
    encoding: 'br' | 'gzip'
  ): Promise<Uint8Array> {
    if (encoding === 'br') {
      if (this.#brotli === null) {
        const { compress } = await import(deno_x_brotli)
        this.#brotli = compress
      }
      return this.#brotli!(data)
    } else if (encoding === 'gzip') {
      if (this.#gzip === null) {
        const denoflate = await import(deno_x_flate)
        this.#gzip = (data: Uint8Array) => denoflate.gzip(data, undefined)
      }
      return this.#gzip!(data)
    }

    return data
  }
}

export default new Compression()
