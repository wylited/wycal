{
  description = "wycal — CalDAV/CardDAV web client (static build + NixOS service)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    bun2nix = {
      # lockfile -> nix expression; schema-unstable between versions, pin the
      # commit. PR head 0456acb accepts bun.lock v2 (bun 1.4+); the released
      # 2.1.2 rejects it. Re-pin to a tag when PR #110 ships.
      url = "github:nix-community/bun2nix/0456acb1b7394fc14c414b056aa889df5124943a";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, nixpkgs, bun2nix }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.callPackage ./nix/package.nix {
            src = self;
            bun2nix = bun2nix.packages.${system}.default;
          };
        }
      );

      nixosModules = {
        wycal = import ./nix/module.nix;
        default = self.nixosModules.wycal;
      };
    };
}
