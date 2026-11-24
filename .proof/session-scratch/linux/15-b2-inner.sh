for p in /proc/[0-9]*; do
  bee=$(tr '\0' '\n' < $p/environ 2>/dev/null | sed -n 's/^HIVE_BEE_ID=//p' | head -1); [ -n "$bee" ] || continue
  echo "$bee $(ps -o sid=,etimes=,comm= -p ${p#/proc/})"
done | awk '{ n[$1]++; if (!root[$1] || $2 < root[$1]) root[$1] = $2; row[NR] = $0 }
  END { for (i in row) { split(row[i], f, " "); if (f[2] != root[f[1]] && f[3] > 600) { away[f[1]]++; kind[f[4]]++ } }
        for (b in n) { bees++; if (away[b]) withbg++ }
        print bees " bees with live processes; " withbg " have long-lived processes outside the harness session"
        for (k in kind) print "  " kind[k], k }'
