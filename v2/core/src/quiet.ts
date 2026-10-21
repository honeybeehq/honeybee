export const QUIET_REPLY = '<quiet/>'

export interface QuietReply {
  said: string
  quiet: boolean
}

export function quietReply(text: string, token: string = QUIET_REPLY): QuietReply {
  const blank = /[\s\p{Default_Ignorable_Code_Point}\u2800]/u
  const before = (at: number): string => {
    const low = text.charCodeAt(at - 1)
    return at >= 2 && low >= 0xdc00 && low <= 0xdfff ? text.slice(at - 2, at) : text.charAt(at - 1)
  }
  let end = text.length
  let cut = -1
  for (;;) {
    while (end > 0 && blank.test(before(end))) end -= before(end).length
    if (end < token.length || !text.startsWith(token, end - token.length)) break
    end -= token.length
    cut = end
  }
  const said = cut >= 0 ? text.slice(0, cut).trimEnd() : text
  const empty = said.replace(/[\p{Default_Ignorable_Code_Point}\u2800]/gu, '').trim() === ''
  return { said: empty ? '' : said, quiet: cut >= 0 && empty }
}

export function spokenReply(text: string): string | null {
  const reply = quietReply(text)
  return reply.quiet || reply.said === '' ? null : reply.said.trim()
}
