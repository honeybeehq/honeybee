export const QUIET_REPLY = '<quiet/>'

export interface QuietReply {
  said: string
  quiet: boolean
}

export function quietReply(text: string, token: string = QUIET_REPLY): QuietReply {
  const blank = /[\s\p{Default_Ignorable_Code_Point}⠀]/u
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
  const quiet = cut >= 0
  const said = quiet ? text.slice(0, cut).trimEnd() : text
  return { said: said.replace(/[\p{Default_Ignorable_Code_Point}⠀]/gu, '').trim() === '' ? '' : said, quiet }
}

export function spokenReply(text: string): string | null {
  const reply = quietReply(text)
  return reply.quiet || reply.said === '' ? null : reply.said.trim()
}
