; Instalador do plugin para Windows (Inno Setup 6). O CI compila com:
;   ISCC /DVersion=0.2.0 /DSource=<pasta com "noveau DAW.vst3"> /O<saída> windows.iss
; Coloca o VST3 na pasta padrão, onde toda DAW procura (e o Plugin Buddy também).
; O AAX não vai junto: sem a assinatura da Avid, o Pro Tools comum recusa e mostra erro ao abrir.

#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Source
  #define Source "..\..\build\NoveauDAW_artefacts\Release\VST3"
#endif

[Setup]
AppId={{8F1E3C52-6D4B-4F0E-9B7A-2E5C1D9A7B31}
AppName=noveau DAW
AppVersion={#Version}
AppPublisher=noveau
AppPublisherURL=https://noveau.riajuu.net/plugin
DefaultDirName={commoncf64}\VST3
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=noveau-DAW-Windows
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=noveau DAW (plugin)
UninstallFilesDir={commonpf64}\noveau DAW
CloseApplications=no

[Languages]
Name: "pt"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
pt.AbrirPagina=Abrir o passo a passo
en.AbrirPagina=Open the step-by-step guide

[Messages]
pt.FinishedLabel=O plugin noveau DAW foi instalado.%n%nAbra (ou reabra) a sua DAW e coloque o noveau DAW como último efeito do master. No plugin, clique em "Conectar com o Discord".%n%nPro Tools: use o Plugin Buddy (passo a passo na página que vai abrir).
en.FinishedLabel=noveau DAW was installed.%n%nOpen (or reopen) your DAW and put noveau DAW as the last effect on the master. In the plugin, click "Conectar com o Discord".%n%nPro Tools: use Plugin Buddy (steps on the page that will open).

[InstallDelete]
Type: filesandordirs; Name: "{commoncf64}\VST3\noveau DAW.vst3"

[Files]
Source: "{#Source}\noveau DAW.vst3\*"; DestDir: "{commoncf64}\VST3\noveau DAW.vst3"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
Filename: "https://noveau.riajuu.net/plugin?instalado=1"; Description: "{cm:AbrirPagina}"; Flags: shellexec postinstall nowait skipifsilent
