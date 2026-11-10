#!/bin/bash
# Monta o instalador .pkg do Mac a partir dos plugins já compilados e assinados (ad hoc).
#   plugin/installer/mac-pkg.sh <pasta com "noveau DAW.vst3" e "noveau DAW.component"> <versão> <saída.pkg>
# Arquivos instalados por um .pkg não ganham a "quarentena" do macOS, então a DAW carrega o
# plugin sem o usuário ter que mexer no Terminal: basta liberar o instalador uma vez em
# Ajustes do Sistema > Privacidade e Segurança > Abrir Mesmo Assim.
set -euo pipefail
src=$1
version=$2
out=$3
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)

root="$work/root"
mkdir -p "$root/Library/Audio/Plug-Ins/VST3" "$root/Library/Audio/Plug-Ins/Components"
cp -R "$src/noveau DAW.vst3" "$root/Library/Audio/Plug-Ins/VST3/"
cp -R "$src/noveau DAW.component" "$root/Library/Audio/Plug-Ins/Components/"

# Sem isso o Installer "segue" uma cópia antiga do plugin para onde ela estiver (bundle relocável).
pkgbuild --analyze --root "$root" "$work/components.plist"
i=0
while /usr/libexec/PlistBuddy -c "Print :$i" "$work/components.plist" >/dev/null 2>&1; do
  /usr/libexec/PlistBuddy -c "Set :$i:BundleIsRelocatable false" "$work/components.plist"
  i=$((i + 1))
done

mkdir -p "$work/scripts"
cat > "$work/scripts/postinstall" <<'SH'
#!/bin/sh
# O Logic só enxerga um Audio Unit novo depois que o registro é refeito.
killall -9 AudioComponentRegistrar 2>/dev/null || true
exit 0
SH
chmod +x "$work/scripts/postinstall"

pkgbuild --root "$root" --component-plist "$work/components.plist" --scripts "$work/scripts" \
  --identifier net.riajuu.noveau.daw.pkg --version "$version" --install-location / "$work/noveau-DAW.pkg"

mkdir -p "$work/res"
cp "$here/mac-welcome.html" "$here/mac-conclusion.html" "$work/res/"
cat > "$work/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>noveau DAW</title>
  <welcome file="mac-welcome.html" mime-type="text/html"/>
  <conclusion file="mac-conclusion.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default" title="noveau DAW"><pkg-ref id="net.riajuu.noveau.daw.pkg"/></choice>
  <pkg-ref id="net.riajuu.noveau.daw.pkg" version="$version">noveau-DAW.pkg</pkg-ref>
</installer-gui-script>
XML
productbuild --distribution "$work/distribution.xml" --resources "$work/res" --package-path "$work" "$out"
rm -rf "$work"
echo "pronto: $out"
