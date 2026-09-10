# Renders the banner-annotated Workshop previews for the Regions and Societies family:
# a uniform dark series banner on top, the mod's accent banner on the bottom naming what it
# patches (or which core edition it is), an opaque monoline emblem in the top-left corner,
# and an opaque version stamp read live from each repo's About.xml — so re-running this
# after a version bump restamps every preview. The pristine base art lives in
# rs-preview-base/ next to this script (NOT the repos' About/Preview.png, which carry the
# rendered banners and would stack if reused as input). Review the output in -OutDir, then
# copy over each repo's About/Preview.png. Output is recompressed with the MCP server's
# sharp to stay under Steam's 1 MB preview cap.
param([string]$OutDir = (Join-Path $env:TEMP 'rs-previews'))
Add-Type -AssemblyName System.Drawing

$out = $OutDir
New-Item -ItemType Directory -Force $out | Out-Null

$mods = @(
    @{ repo='World-Domination-CP'; top='REGIONS AND SOCIETIES: CP SERIES'; bottom='WORLD DOMINATION 2.0';      accent='#943A31'; emblem='swords' },
    @{ repo='VFE-CP';              top='REGIONS AND SOCIETIES: CP SERIES'; bottom='VANILLA FACTIONS EXPANDED'; accent='#295294'; emblem='rings' },
    @{ repo='VOE-CP';              top='REGIONS AND SOCIETIES: CP SERIES'; bottom='VANILLA OUTPOSTS EXPANDED'; accent='#7B3A84'; emblem='tower' },
    @{ repo='Empire-CP';           top='REGIONS AND SOCIETIES: CP SERIES'; bottom='EMPIRE REFACTORED';         accent='#B59C21'; emblem='crown' },
    @{ repo='Core-MMF';            top='REGIONS AND SOCIETIES CORE';       bottom='MAP MODE FRAMEWORK';        accent='#1F7E8C'; emblem='layers' },
    @{ repo='Core-RP2';            top='REGIONS AND SOCIETIES CORE';       bottom='REALISTIC PLANETS 2';       accent='#A8642B'; emblem='planet' }
)

function Get-FitFont([System.Drawing.Graphics]$g, [string]$text, [single]$maxSize, [single]$maxWidth) {
    for ($s = $maxSize; $s -ge 24; $s -= 2) {
        $f = New-Object System.Drawing.Font('Segoe UI', $s, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        if ($g.MeasureString($text, $f).Width -le $maxWidth) { return $f }
        $f.Dispose()
    }
    return New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
}

function Darken([System.Drawing.Color]$c, [double]$k) {
    [System.Drawing.Color]::FromArgb(255, [int]($c.R * $k), [int]($c.G * $k), [int]($c.B * $k))
}
function Lighten([System.Drawing.Color]$c, [double]$k) {
    [System.Drawing.Color]::FromArgb(255, [int]($c.R + (255 - $c.R) * $k), [int]($c.G + (255 - $c.G) * $k), [int]($c.B + (255 - $c.B) * $k))
}

# Draws one emblem's monoline shapes with the given pen around origin (0,0) in local units
# (roughly +-70); the caller sets the Graphics transform for position/scale/shadow passes.
function Draw-EmblemShapes([System.Drawing.Graphics]$g, [System.Drawing.Pen]$pen, [string]$emblem) {
    switch ($emblem) {
        'crown' {
            $pts = [System.Drawing.PointF[]]@(
                (New-Object System.Drawing.PointF -70, 40), (New-Object System.Drawing.PointF -78, -18),
                (New-Object System.Drawing.PointF -38, 12), (New-Object System.Drawing.PointF 0, -42),
                (New-Object System.Drawing.PointF 38, 12),  (New-Object System.Drawing.PointF 78, -18),
                (New-Object System.Drawing.PointF 70, 40))
            $g.DrawPolygon($pen, $pts)
            foreach ($tip in @(@(-78,-18), @(0,-42), @(78,-18))) { $g.DrawEllipse($pen, [single]($tip[0]-8), [single]($tip[1]-24), 16, 16) }
            foreach ($jx in @(-40, 0, 40)) { $g.DrawEllipse($pen, [single]($jx-6), 22, 12, 12) }
        }
        'swords' {
            $g.DrawLine($pen, -60, -60, 40, 40);  $g.DrawLine($pen, 26, 54, 54, 26)   # blade A + guard
            $g.DrawLine($pen, 46, 46, 58, 58);    $g.DrawEllipse($pen, 56, 56, 14, 14) # grip A + pommel
            $g.DrawLine($pen, 60, -60, -40, 40);  $g.DrawLine($pen, -26, 54, -54, 26)  # blade B + guard
            $g.DrawLine($pen, -46, 46, -58, 58);  $g.DrawEllipse($pen, -70, 56, 14, 14)
        }
        'tower' {
            $g.DrawLine($pen, -40, 58, 40, 58)                                        # ground
            $g.DrawLine($pen, -32, 58, -16, -12); $g.DrawLine($pen, 32, 58, 16, -12)  # legs
            $g.DrawLine($pen, -26, 34, 26, 10);   $g.DrawLine($pen, 26, 34, -26, 10)  # cross-brace
            $g.DrawRectangle($pen, -26, -26, 52, 14)                                  # platform
            $pts = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF -32, -26), (New-Object System.Drawing.PointF 0, -54), (New-Object System.Drawing.PointF 32, -26))
            $g.DrawLines($pen, $pts)                                                  # roof
            $g.DrawLine($pen, 0, -54, 0, -70)                                         # flagpole
            $pts = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 0, -70), (New-Object System.Drawing.PointF 20, -63), (New-Object System.Drawing.PointF 0, -56))
            $g.DrawPolygon($pen, $pts)                                                # flag
        }
        'rings' {
            $g.DrawEllipse($pen, -52, -40, 56, 56); $g.DrawEllipse($pen, -4, -40, 56, 56); $g.DrawEllipse($pen, -28, 2, 56, 56)
        }
        'layers' {
            $pts = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 0, -50), (New-Object System.Drawing.PointF 54, -24), (New-Object System.Drawing.PointF 0, 2), (New-Object System.Drawing.PointF -54, -24))
            $g.DrawPolygon($pen, $pts)                                                # top layer
            $pts = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF -54, 0), (New-Object System.Drawing.PointF 0, 26), (New-Object System.Drawing.PointF 54, 0))
            $g.DrawLines($pen, $pts)                                                  # middle chevron
            $pts = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF -54, 24), (New-Object System.Drawing.PointF 0, 50), (New-Object System.Drawing.PointF 54, 24))
            $g.DrawLines($pen, $pts)                                                  # bottom chevron
        }
        'planet' {
            $g.DrawEllipse($pen, -34, -34, 68, 68)                                    # body
            $st = $g.Save(); $g.RotateTransform(-22)
            $g.DrawEllipse($pen, -66, -16, 132, 32)                                   # ring
            $g.Restore($st)
        }
    }
}

function Draw-Emblem([System.Drawing.Graphics]$g, [string]$emblem, [System.Drawing.Color]$accent, [single]$cx, [single]$cy, [single]$scale) {
    $shadowPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(200, 12, 16, 24)), 9
    $mainPen   = New-Object System.Drawing.Pen (Lighten $accent 0.30), 6.5
    foreach ($p in @($shadowPen, $mainPen)) { $p.LineJoin = 'Round'; $p.StartCap = 'Round'; $p.EndCap = 'Round' }

    $st = $g.Save()
    $g.TranslateTransform($cx + 3, $cy + 4); $g.ScaleTransform($scale, $scale)
    Draw-EmblemShapes $g $shadowPen $emblem
    $g.Restore($st)

    $st = $g.Save()
    $g.TranslateTransform($cx, $cy); $g.ScaleTransform($scale, $scale)
    Draw-EmblemShapes $g $mainPen $emblem
    $g.Restore($st)

    $shadowPen.Dispose(); $mainPen.Dispose()
}

$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'

foreach ($m in $mods) {
    $src = Join-Path $PSScriptRoot "rs-preview-base\$($m.repo).png"
    $bmp = New-Object System.Drawing.Bitmap 1024, 1024
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $srcImg = [System.Drawing.Image]::FromFile($src)
    $g.DrawImage($srcImg, 0, 0, 1024, 1024)
    $srcImg.Dispose()

    $accent = [System.Drawing.ColorTranslator]::FromHtml($m.accent)
    $dark   = Darken $accent 0.62
    $navy   = [System.Drawing.Color]::FromArgb(255, 16, 22, 33)
    $white  = [System.Drawing.Brushes]::White
    $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(160, 0, 0, 0))

    # Top series banner: dark ground, accent keel stripe, uniform wording across the family.
    $topH = 110
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $navy), 0, 0, 1024, $topH)
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 0, $topH - 7, 1024, 7)
    $f = Get-FitFont $g $m.top 54 950
    $r = New-Object System.Drawing.RectangleF 0, 0, 1024, ($topH - 7)
    $rs = New-Object System.Drawing.RectangleF 3, 3, 1024, ($topH - 7)
    $g.DrawString($m.top, $f, $shadow, $rs, $fmt)
    $g.DrawString($m.top, $f, $white, $r, $fmt)
    $f.Dispose()

    # Opaque per-mod emblem in the upper-left starfield corner.
    Draw-Emblem $g $m.emblem $accent 156 232 1.45

    # Version stamp template: bottom-right of the art, just above the bottom banner, mostly
    # transparent so it reads on hover without competing with the graphic. The version comes
    # from the repo's About.xml at render time, so re-running after a bump restamps it.
    $aboutXml = [xml](Get-Content "C:\github\regions-and-societies\$($m.repo)\About\About.xml" -Raw)
    $ver = "v$($aboutXml.ModMetaData.modVersion)"
    $vf = New-Object System.Drawing.Font('Segoe UI', 30, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $vw = $g.MeasureString($ver, $vf).Width
    $vShadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(170, 0, 0, 0))
    $vBrush  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $g.DrawString($ver, $vf, $vShadow, 1024 - $vw - 22, 845 - 44)
    $g.DrawString($ver, $vf, $vBrush, 1024 - $vw - 24, 845 - 46)
    $vf.Dispose()

    # Bottom identity banner: covers the old one (old banners start at y=853 on the CPs).
    $bTop = 845
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $accent), 0, $bTop, 1024, 1024 - $bTop)
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $dark), 0, $bTop, 1024, 8)
    $f = Get-FitFont $g $m.bottom 78 950
    $r = New-Object System.Drawing.RectangleF 0, ($bTop + 8), 1024, (1024 - $bTop - 8)
    $rs = New-Object System.Drawing.RectangleF 4, ($bTop + 12), 1024, (1024 - $bTop - 8)
    $g.DrawString($m.bottom, $f, $shadow, $rs, $fmt)
    $g.DrawString($m.bottom, $f, $white, $r, $fmt)
    $f.Dispose()

    $g.Dispose()
    $dest = Join-Path $out "$($m.repo)-Preview.png"
    $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    "{0}: {1} KB" -f $m.repo, [math]::Round((Get-Item $dest).Length / 1KB)
}

# Recompress with sharp — GDI+'s PNG encoder writes ~4x larger files than needed, and the
# cores would blow Steam's 1 MB preview cap without this pass.
$sharpDir = Join-Path $PSScriptRoot '..\server\node_modules\sharp'
if (Test-Path $sharpDir) {
    $js = @'
const sharp = require(process.argv[2]); const fs = require("fs"), path = require("path");
const dir = process.argv[3];
(async () => { for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".png"))) {
  const p = path.join(dir, f);
  const buf = await sharp(p).png({ compressionLevel: 9, effort: 10 }).toBuffer();
  fs.writeFileSync(p, buf); console.log(f, Math.round(buf.length / 1024) + " KB"); } })();
'@
    $tmp = Join-Path $env:TEMP 'rs-preview-recompress.js'
    Set-Content $tmp $js -Encoding UTF8
    node $tmp (Resolve-Path $sharpDir).Path $out
} else {
    Write-Warning 'sharp not found next to the harness - previews left as GDI+ PNGs; check each stays under 1 MB.'
}
