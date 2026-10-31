import { describe, expect, it } from "bun:test";
import { InstallationAclPresentError } from "../src/cli/install-activation";

describe("InstallationAclPresentError", () => {
	it("identifies an inherited unsafe principal and preserves the ACL error code", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Users\Alice\.local\bin\gjc.exe`, {
			aclFailurePrincipal: String.raw`BUILTIN\Users`,
			aclFailureInherited: true,
		});

		expect(error.code).toBe("acl_present");
		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Users\Alice\.local\bin\gjc.exe: ACE for "BUILTIN\Users" is inherited from a parent directory. Run: icacls "C:\Users\Alice\.local\bin" /inheritance:d && icacls "C:\Users\Alice\.local\bin" /remove "BUILTIN\Users" && gjc update`,
		);
	});

	it("identifies an explicitly set unsafe principal when inherited is false", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, {
			aclFailurePrincipal: "S-1-5-32-545",
			aclFailureInherited: false,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Tools\gjc.exe: ACE for "S-1-5-32-545" is explicitly set. Run: icacls "C:\Tools" /inheritance:d && icacls "C:\Tools" /remove "S-1-5-32-545" && gjc update`,
		);
	});

	it("falls back to the bare error when both diagnostic fields are absent", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, {});

		expect(error.message).toBe("acl_present");
	});

	it("omits the remedy when the principal is absent", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, {
			aclFailureInherited: true,
		});

		expect(error.message).toBe("acl_present");
	});

	it("omits the remedy when the inherited flag is absent", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, {
			aclFailurePrincipal: String.raw`BUILTIN\Users`,
		});

		expect(error.message).toBe("acl_present");
	});

	it("quotes directory and principal names containing spaces in the ordered remedy commands", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Program Files\GJC\gjc.exe`, {
			aclFailurePrincipal: String.raw`CONTOSO\Domain Users`,
			aclFailureInherited: true,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Program Files\GJC\gjc.exe: ACE for "CONTOSO\Domain Users" is inherited from a parent directory. Run: icacls "C:\Program Files\GJC" /inheritance:d && icacls "C:\Program Files\GJC" /remove "CONTOSO\Domain Users" && gjc update`,
		);
	});

	it("includes the exact target file path while directing the remedy to its UNC parent directory", () => {
		const error = new InstallationAclPresentError(String.raw`\\server\share\GJC Tools\gjc-custom.exe`, {
			aclFailurePrincipal: "Everyone",
			aclFailureInherited: false,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of \\server\share\GJC Tools\gjc-custom.exe: ACE for "Everyone" is explicitly set. Run: icacls "\\server\share\GJC Tools" /inheritance:d && icacls "\\server\share\GJC Tools" /remove "Everyone" && gjc update`,
		);
	});
});
