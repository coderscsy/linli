function Set-OliviaSoulLocalMidiLocale {
    param(
        [Parameter(Mandatory = $true)][string]$ExtractedRoot,
        [Parameter(Mandatory = $true)][Text.Encoding]$Utf8
    )

    $localeFiles = @(Get-ChildItem -LiteralPath (Join-Path $ExtractedRoot "assets") -Filter "zh-cn-*.js" -File)
    if ($localeFiles.Count -ne 1) { throw "expected one zh-cn locale, got $($localeFiles.Count)" }
    $localePath = $localeFiles[0].FullName
    $localeText = [IO.File]::ReadAllText($localePath, $Utf8)
    $localeReplacementBase64 = @(
        @('SnM9IuS7iuWkqei/mOWPr+WumuWItiB7cmVtYWluaW5nfSDpppYi', 'SnM9IuS4jemZkOasoeaVsCI='),
        @('bj0i5byA5aeL5a6a5Yi25L2g55qE5ryU5aWP5ZCn772eIg==', 'bj0i5LiK5LygIC5taWQvLm1pZGnvvIzmiJblnKjmnKzlnLDmnI3liqHlr7zlhaXlt7LkuIvovb3mm7LlupPjgIIi'),
        @('Yz0i5LuF5pSv5oyBIC5taWQg5qC85byP5paH5Lu277yM5aSn5bCPPDFNQu+8jOaXtumVvzwxMCDliIbpkp/jgILku4XlkKvpkqLnkLTljZXkuIDkuZDlmajvvIzkuI3lvpflh7rnjrDkurrlo7DmiJblhbbku5bkuZDlmajjgIIi', 'Yz0i5pSv5oyBIC5taWQvLm1pZGnvvIzljZXmlofku7bmnIDlpKcgNjQgTWlC77yM5LiN6ZmQ5qyh5pWw44CC5Y+q5pyJIE1JREkg5pe277yM5pys5Zyw5pyN5Yqh5Lya5oyJ6Z+z56ym55Sf5oiQ5Y+v5pKt5pS+IE1QNOOAgiI='),
        @('cj0i55Sx6Z+z6aKR5paH5Lu255u05o6l6L2s5Ye655qEIC5taWQg5Y+v6IO95ryU5aWP5YeG56Gu5bqm6L6D5L2O77yb5aaC5pyJ6ZKi55C06LiP5p2/5bu26Z+z77yM6ZyA5Lul56uW57q/5qCH6K+G5L2T546w44CCIg==', 'cj0i5bey5LiL6L2955qE5YiG5Lqr56CB5puy55uu5Y+v5Zyo5pys5Zyw5pyN5Yqh5Lit5a+85YWl77yb55Sf5oiQ5paH5Lu25L+d5a2Y5ZyoIE1JREkg5pWw5o2u55uu5b2V77yM5pKt5pS+57yT5a2Y6Lef6ZqP5puy55uu5a2Y5YKo6Lev5b6E44CCIg=='),
        @('c3Q9IuWPr+S7pemAmui/h+S4iuS8oOaMh+WumuagvOW8j+eahOmfs+S5kOaWh+S7tuaIluS9v+eUqOWIhuS6q+egge+8jOW8gOWQr+S9oOeahOS4quaAp+WMluWIm+S9nOS9k+mqjOOAgiI=', 'c3Q9IuS4iuS8oCAubWlkLy5taWRpIOWNs+WPr+eUn+aIkOacrOWcsOa8lOWlj++8m+W3suS4i+i9veeahOWIhuS6q+eggeabsuebruWPr+mAmui/h+acrOWcsOabsuW6k+WvvOWFpeaBouWkjeOAgiI='),
        @('RnQ9IuS4uuS6huiOt+W+l+acgOS9s+aViOaenO+8jOivt+S4iuS8oOmSoueQtOeLrOWlj+eahOWNlei9qCBNSURJ77yM6YG/5YWN5YyF5ZCr5Lq65aOw5oiW5YW25LuW5LmQ5Zmo44CC6K+m6KeBIg==', 'RnQ9IuS4iuS8oCAubWlkIOaIliAubWlkaSDlkI7kvJrmjInpn7PnrKbnlJ/miJDmnKzlnLDmvJTlpY/op4bpopHvvJvnlJ/miJDmnJ/pl7Tlj6/ku6XlhbPpl63lvLnnqpfjgILor6bop4Ei'),
        @('R3Q9IuOAik1JREkg5a6a5Yi25ryU5aWP5LiK5Lyg5pS755Wl44CLIg==', 'R3Q9IuOAiuacrOWcsCBNSURJIOS9v+eUqOivtOaYjuOAiyI='),
        @('VHQ9IuKAoiDku4XmlK/mjIEgLm1pZCDmoLzlvI/nmoQgTUlESSDmlofku7bvvIzljIXlkKsgMeKAkzIg5p2h6L2o6YGT77yM5paH5Lu25aSn5bCPIDwgMU1C77yM5LmQ5puy5pe26ZW/IDwgMTAg5YiG6ZKf44CCIg==', 'VHQ9IuKAoiDmlK/mjIEgLm1pZC8ubWlkae+8jOWNleaWh+S7tuacgOWkpyA2NCBNaULvvIzkuI3pmZDmrKHmlbDvvJvlu7rorq7ljIXlkKvlrozmlbTnmoTpgJ/luqbjgIHpn7PnrKblkozouI/mnb/kuovku7bjgIIi'),
        @('VnQ9IuKAoiDkuI3lu7rorq7nm7TmjqXnlLHpn7PpopHovawgTUlESe+8jOWPr+iDveS8muW9seWTjea8lOWlj+WHhuehruaAp+OAguivt+ehruS/neS4iuS8oOeahOmfs+S5kOS4jeS+teeKr+esrOS4ieaWueeJiOadg+OAgiI=', 'VnQ9IuKAoiDlj6rmnIkgTUlESSDkuZ/lj6/ku6XkuIrkvKDvvIzmnKzlnLDmnI3liqHkvJroh6rliqjnlJ/miJDpkqLnkLTpn7PpopHlkozmvJTlpY/op4bpopHvvIzlrozmiJDlkI7ov5vlhaXigJzmiJHnmoTkuIrkvKDigJ3jgIIi'),
        @('V3Q9IuKAoiBNSURJIOS4reWPquiDveS9v+eUqOmSoueQtOWNleS4gOS5kOWZqO+8jOS4jeW+l+WMheWQq+S6uuWjsOaIluWFtuS7luS5kOWZqO+8m+Wmguaciei4j+adv+W7tumfs++8jOmcgOWcqCBNSURJIOS4reeUqOerlue6v+agh+azqOOAgiI=', 'V3Q9IuKAoiDnlJ/miJDmlofku7bkv53lrZjlnKjmnKzlnLDmnI3liqHmmL7npLrnmoQgTUlESSDmlbDmja7nm67lvZXvvJvmkq3mlL7nvJPlrZjkvJrot5/pmo/orr7nva7kuK3nmoTmm7Lnm67lrZjlgqjot6/lvoToh6rliqjliqDovb3jgIIi'),
        @('VW49IuaWh+S7tuWkp+Wwj+W/hemhu+Wwj+S6jjVNQiI=', 'VW49Ik1JREkg5paH5Lu25LiN6IO96LaF6L+HIDY0IE1pQiI='),
        @('Q249IuaWh+S7tuagvOW8j+W/hemhu+S4ui5taWQi', 'Q249Iuivt+mAieaLqSAubWlkIOaIliAubWlkaSDmlofku7Yi')
    )
    foreach ($replacementBase64 in $localeReplacementBase64) {
        $from = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($replacementBase64[0]))
        $to = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($replacementBase64[1]))
        $count = ([regex]::Matches($localeText, [regex]::Escape($from))).Count
        $localizedCount = ([regex]::Matches($localeText, [regex]::Escape($to))).Count
        if ($count -eq 1 -and $localizedCount -eq 0) {
            $localeText = $localeText.Replace($from, $to)
        } elseif ($count -ne 0 -or $localizedCount -ne 1) {
            throw "expected one locale text occurrence, got old=$count new=$localizedCount"
        }
    }
    [IO.File]::WriteAllText($localePath, $localeText, $Utf8)
}
