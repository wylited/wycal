{
  lib,
  stdenv,
  bun2nix,
  src,
}:
# Static Vite build of the wycal client: `bun install` from the bun2nix cache,
# then `tsc -b && vite build`. Output is the dist/ tree (index.html + assets).
#
# Regenerate ./bun.nix after changing dependencies:
#   nix run github:nix-community/bun2nix/0456acb1b7394fc14c414b056aa889df5124943a -- -o bun.nix
# (upstream commit accepting bun.lock v2; released 2.1.2 only parses v1)
stdenv.mkDerivation (finalAttrs: {
  pname = "wycal";
  version = "0.1.0";

  inherit src;

  nativeBuildInputs = [ bun2nix.hook ]; # hook propagates bun + yq-go

  bunDeps = bun2nix.fetchBunDeps { bunNix = src + "/bun.nix"; };

  # cache/patch/install phases are wired by the bun2nix hook
  # (preConfigurePhases + preBuildPhases) — this phase only builds.
  buildPhase = ''
    runHook preBuild
    bun run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cp -r dist $out
    runHook postInstall
  '';

  meta = {
    description = "Fast, pretty CalDAV + CardDAV web client for Radicale";
    homepage = "https://github.com/wylited/wycal";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
})
