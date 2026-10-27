# NixOS module: serve the wycal static client behind an existing reverse
# proxy (e.g. the caddy vhost that terminates cal.ts.wyli.tech). The app is a
# pure SPA with hash routing — darkhttpd on a loopback port is the whole
# runtime; DAV traffic goes from the browser to the CalDAV server directly
# (dav.ts.wyli.tech carries the CORS headers), so no proxying here.
{
  lib,
  config,
  pkgs,
  ...
}:

let
  cfg = config.services.wycal;
in
{
  options.services.wycal = {
    enable = lib.mkEnableOption "wycal CalDAV web UI";

    package = lib.mkOption {
      type = lib.types.package;
      description = "wycal static site package (flake `packages.<system>.default`)";
    };

    address = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "listen address";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8423;
      description = "listen port (matches the cal.ts.wyli.tech caddy route)";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.wycal = {
      description = "wycal — CalDAV/CardDAV web client (static)";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        ExecStart = "${lib.getExe pkgs.darkhttpd} ${cfg.package} --addr ${cfg.address} --port ${toString cfg.port}";
        DynamicUser = true;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
        RestrictNamespaces = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        SystemCallArchitectures = "native";
      };
    };
  };
}
