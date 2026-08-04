"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useId, useState } from "react";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  ChevronRight,
  LayoutDashboard,
  Users,
  FileText,
  Clock,
  CalendarDays,
  BookMinus,
  HandCoins,
  ClipboardClock,
  Banknote,
  Handshake,
  TriangleAlertIcon,
  ScanLine,
  Receipt,
} from "lucide-react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";

interface NavSidebarProps {
  userRole: string; // Use string (primitive) type, not String (object)
}

type MenuSubItem = {
  label: string;
  path: string;
  roles?: string[];
};

type MenuItem = {
  id: string;
  label: string;
  icon: typeof LayoutDashboard;
  href: string;
  hasSubmenu: boolean;
  roles: string[];
  subItems?: MenuSubItem[];
};

const NavSidebar = ({ userRole }: NavSidebarProps) => {
  const [openStates, setOpenStates] = useState<Record<string, boolean>>({});
  const { state } = useSidebar();
  const pathname = usePathname();
  const collapsibleId = useId(); // Generate a stable ID prefix
  const isSidebarCollapsed = state === "collapsed";

  const updateOpenState = (key: string, value: boolean) => {
    if (!isSidebarCollapsed) {
      setOpenStates((current) => {
        const nextState = { ...current };
        if (value) {
          Object.keys(nextState).forEach((stateKey) => {
            if (stateKey !== key) nextState[stateKey] = false;
          });
        }
        nextState[key] = value;
        return nextState;
      });
    }
  };

  const menuItems: MenuItem[] = [
    // ========== DASHBOARD MENU ========== //
    {
      id: "dashboard",
      label: "Dashboard",
      icon: LayoutDashboard,
      href: `/${userRole}/dashboard`,
      hasSubmenu: false,
      // ========== DASHBOARD ACCESS ========= //
      roles: ["admin", "generalManager", "manager", "supervisor", "employee"],
    },
    // ========== USERS MENU ========== //
    {
      id: "user",
      label: "User",
      icon: Users,
      href: `/${userRole}/users`,
      hasSubmenu:
        userRole === "admin" ||
        userRole === "generalManager" ||
        userRole === "manager",
      // Subitems: add per-subitem `roles` to control visibility (defaults aligned to parent)
      subItems: [
        {
          label: "Users Directory",
          path: "",
          roles: ["admin", "manager", "generalManager"],
        },
        {
          label: "Add User",
          path: "/create",
          roles: ["admin", "manager", "generalManager"],
        },
      ],
      // ========== USER ACCESS ========= //
      roles: ["admin", "manager", "generalManager"],
    },
    // ========== EMPLOYEES MENU ========== //
    {
      id: "employees",
      label: "Employees",
      icon: Users,
      href: `/${userRole}/employees`,
      hasSubmenu:
        userRole === "admin" ||
        userRole === "generalManager" ||
        userRole === "manager",
      // Subitems: add per-subitem roles (aligned with parent by default)
      subItems: [
        {
          label: "Employees Directory",
          path: "",
          roles: ["admin", "generalManager", "manager"],
        },
        {
          label: "Add Employee",
          path: "/new",
          roles: ["admin", "generalManager"],
        },
      ],
      // ========== EMPLOYEE ACCESS ========= //
      roles: ["admin", "generalManager", "manager"],
    },
    // ========== ORGANIZATION MENU ========== //
    {
      id: "organization",
      label: "Organization",
      icon: Clock,
      href: `/${userRole}/organization`,
      hasSubmenu: true,
      subItems: [
        {
          label: "Departments",
          path: "/departments",
          roles: ["admin", "generalManager"],
        },
        {
          label: "Positions",
          path: "/positions",
          roles: ["admin", "generalManager"],
        },
        {
          label: "Structure",
          path: "/structure",
          roles: ["admin", "generalManager"],
        },
      ],
      // ========== ORGANIZATION ACCESS ========= //
      roles: ["admin", "generalManager"],
    },
    // ========== ATTENDANCE MENU ========== //
    {
      id: "attendance",
      label: "Attendance",
      icon: ClipboardClock,
      href: `/${userRole}/attendance`,
      hasSubmenu: true,
      // Subitems: roles aligned with parent by default
      subItems: [
        {
          label: "Daily Attendance",
          path: "",
          roles: ["admin", "generalManager", "manager", "supervisor"],
        },
        {
          label: "Attendance Logs",
          path: "/history",
          roles: ["admin", "generalManager", "manager", "supervisor"],
        },
        {
          label: "Attendance Settings",
          path: "/settings",
          roles: ["admin"],
        },
        {
          label: "Attendance Locks",
          path: "/locks",
          roles: ["admin", "manager"],
        },
        {
          label: "My Attendance",
          path: "",
          roles: ["employee"],
        },
        {
          label: "History",
          path: "/history",
          roles: ["employee"],
        },
      ],
      // ========== ATTENDANCE ACCESS ========= //
      roles: ["admin", "generalManager", "manager", "supervisor", "employee"],
    },
    // ========== SCHEDULE MENU ========== //
    {
      id: "schedule",
      label: "Schedule",
      icon: CalendarDays,
      href: `/${userRole}/schedule`,
      hasSubmenu: true,
      subItems: [
        {
          label: "Overrides",
          path: "/overrides",
          roles: ["admin", "manager"],
        },
        {
          label: "Shifts",
          path: "/shifts",
          roles: ["admin", "manager"],
        },
        {
          label: "Weekly Schedule",
          path: "/patterns",
          roles: ["admin", "manager"],
        },
        {
          label: "View Schedule",
          path: "",
          roles: ["employee"],
        },
        {
          label: "View Team Schedule",
          path: "",
          roles: ["supervisor"],
        },
      ],
      // ========== SCHEDULE ACCESS ========= //
      roles: ["admin", "manager", "employee", "supervisor"],
    },
    // ========== DEDUCTION MENU ========== //
    {
      id: "deduction",
      label: "Deductions",
      icon: BookMinus,
      href: `/${userRole}/deductions`,
      hasSubmenu: true,
      subItems: [
        {
          label: "Deduction Types",
          path: "",
          roles: ["admin", "generalManager"],
        },
        {
          label: "Employee Deductions",
          path: "/employee",
          roles: ["admin", "generalManager", "manager"],
        },
        {
          label: "Review Drafts",
          path: "",
          roles: ["manager"],
        },
        {
          label: "Review Drafts",
          path: "/review",
          roles: ["admin"],
        },
        {
          label: "Assign Deduction",
          path: "/add",
          roles: ["admin", "manager"],
        },
        {
          label: "My Deductions",
          path: "",
          roles: ["employee"],
        },
      ],
      roles: ["admin", "generalManager", "manager", "employee"],
    },
    // ========== CONTRIBUTION MENU ========== //
    {
      id: "contributions",
      label: "Contributions",
      icon: HandCoins,
      href: `/${userRole}/contributions`,
      hasSubmenu: false,
      // ========== CONTRIBUTION ACCESS ========= //
      roles: ["admin", "generalManager", "manager", "employee"],
    },
    // ========== VIOLATION MENU ========== //
    {
      id: "violation",
      label: "Violation",
      icon: TriangleAlertIcon,
      href: `/${userRole}/violations`,
      hasSubmenu: true,
      subItems: [
        {
          label: "Violation Directory",
          path: "",
          roles: ["admin", "generalManager"],
        },
        {
          label: "Employee Violations",
          path: "/employee",
          roles: ["generalManager", "manager"],
        },
        {
          label: "Review Drafts",
          path: "",
          roles: ["manager"],
        },
        {
          label: "My Drafts",
          path: "",
          roles: ["supervisor"],
        },
        {
          label: "My Violations",
          path: "",
          roles: ["employee"],
        },
        {
          label: "Assign Violation",
          path: "/add",
          roles: ["manager"],
        },
        {
          label: "Draft Violation",
          path: "/add",
          roles: ["supervisor"],
        },
      ],
      // ========== VIOLATION ACCESS ========= //
      roles: ["admin", "generalManager", "manager", "supervisor", "employee"],
    },
    // ========== PAYROLL MENU ========== //
    {
      id: "payroll",
      label: "Payroll",
      icon: Banknote,
      href: `/${userRole}/payroll`,
      hasSubmenu: true,
      subItems: [
        {
          label: "Review Payroll",
          path: "/review-payroll",
          roles: ["generalManager"],
        },
        // {
        //   label: "Payslips",
        //   path: "/payslips",
        //   roles: ["admin", "employee"],
        // },
        {
          label: "Generate Payroll",
          path: "/generate-payroll",
          roles: ["manager"],
        },
        {
          label: "Payroll History",
          path: "/payroll-history",
          roles: ["admin", "manager", "generalManager"],
        },
      ],
      // ========== PAYROLL ACCESS ========= //
      roles: ["admin", "generalManager", "manager"],
    },
    // ========== REQUEST MENU ========== //
    {
      id: "requests",
      label: "Requests",
      icon: Handshake,
      href: `/${userRole}/requests`,
      hasSubmenu: true,
      subItems: [
        {
          label: "Review Queue",
          path: "",
          roles: ["manager"],
        },
        {
          label: "Leave Credits",
          path: "/leave-credits",
          roles: ["generalManager"],
        },
        {
          label: "My Requests",
          path: "",
          roles: ["employee"],
        },
        {
          label: "Leave Status",
          path: "/leave",
          roles: ["employee"],
        },
        {
          label: "Day Off Status",
          path: "/day-off",
          roles: ["employee"],
        },
        {
          label: "New Request",
          path: "/add",
          roles: ["employee"],
        },
      ],
      // ========== REQUEST ACCESS ========= //
      roles: ["generalManager", "manager", "employee"],
    },
    // ========== REPORTS MENU ========== //
    {
      id: "reports",
      label: "Reports",
      icon: FileText,
      href: `/${userRole}/reports`,
      hasSubmenu: true,
      subItems: [
        {
          label: "Overview",
          path: "",
          roles: ["generalManager", "manager"],
        },
        {
          label: "Attendance",
          path: "/attendance",
          roles: ["generalManager", "manager"],
        },
        {
          label: "Accounts",
          path: "/accounts",
          roles: ["generalManager", "manager"],
        },
        {
          label: "Employee Information",
          path: "/employee-information",
          roles: ["generalManager", "manager"],
        },
        {
          label: "Contributions",
          path: "/contributions",
          roles: ["generalManager", "manager"],
        },
        {
          label: "Deductions",
          path: "/deductions",
          roles: ["generalManager", "manager"],
        },
        {
          label: "Violations",
          path: "/violations",
          roles: ["generalManager", "manager"],
        },
        {
          label: "Payroll",
          path: "/payroll",
          roles: ["generalManager", "manager"],
        },
      ],
      // ========== REPORT ACCESS ========= //
      roles: ["generalManager", "manager"],
    },
    // ========== PAYSLIP MENU ========= //
    {
      id: "payslip",
      label: "Payslip",
      icon: Receipt,
      href: `/${userRole}/payslip`,
      hasSubmenu: true,
      subItems: [
        {
          label: "My Payslip",
          path: "",
          roles: ["employee"],
        },
        {
          label: "History",
          path: "/history",
          roles: ["employee"],
        },
      ],

      // ========== SCAN ACCESS ========= //
      roles: ["employee"],
    },
    // ========== SCAN MENU ========= //
    {
      id: "scan",
      label: "Scan",
      icon: ScanLine,
      href: `/${userRole}/scan`,
      hasSubmenu: false,
      // ========== SCAN ACCESS ========= //
      roles: ["employee"],
    },
  ];

  const filteredMenuItems = menuItems.filter((item) =>
    item.roles.includes(userRole || "admin"),
  );
  return (
    <div className="flex w-full flex-col items-center space-y-2">
      <SidebarGroup className="w-full">
        <SidebarMenu className="space-y-1 w-full max-w-xs mx-auto">
          {filteredMenuItems.map((item) => {
            // Subitem role gating: only show subitems whose optional 'roles' includes current userRole.
            // To configure, add `roles: ["admin","manager"]` on any subitem object in `menuItems` above.
            const visibleSubItems =
              item.subItems?.filter(
                (subItem) => !subItem.roles || subItem.roles.includes(userRole),
              ) || [];

            if (item.hasSubmenu) {
              return (
                <Collapsible
                  key={item.id}
                  open={!isSidebarCollapsed && (openStates[item.id] || false)}
                  onOpenChange={(value: boolean) =>
                    !isSidebarCollapsed && updateOpenState(item.id, value)
                  }
                  data-collapsible-id={`${collapsibleId}-${item.id}`}
                >
                  <SidebarMenuItem className="group">
                    {/*
                      Inactive hover colors:
                      - Background: hover:bg-orange-100 (light)
                      - Dark mode bg: dark:hover:bg-orange-900/30
                      - Text color: hover:text-orange-600
                      Change these three to customize inactive hover.

                      Active colors (no hover change):
                      - Background: bg-orange-600
                      - Text: text-white
                      Edit these to customize active appearance.
                    */}
                    {/*
                      Row padding: tweak collapsed vs expanded paddings here
                      - Expanded: px-3 py-2
                      - Collapsed: px-0 to keep icon perfectly centered
                    */}
                    <div
                      className={`flex w-full items-center rounded-lg px-3 py-2 transition-[padding,background-color,color] duration-300 ease-out group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0 ${
                        pathname.startsWith(item.href) &&
                        (pathname === item.href ||
                          pathname[item.href.length] === "/")
                          ? "bg-orange-600 text-white hover:bg-orange-600 hover:text-white"
                          : "text-foreground hover:bg-orange-100 dark:hover:bg-orange-900/30 hover:text-orange-600"
                      }`}
                    >
                      <SidebarMenuButton
                        asChild
                        // Tooltip colors: change bg/text/arrow here
                        tooltip={{
                          children: item.label,
                          className:
                            "!bg-orange-600 !text-white border-orange-500 shadow-lg",
                          arrowClassName: "bg-orange-600 fill-orange-600",
                        }}
                        className="w-full text-inherit transition-[width,height,padding,gap] duration-300 ease-out hover:bg-transparent hover:text-inherit active:bg-transparent active:text-inherit focus-visible:ring-0"
                      >
                        <Link
                          href={item.href}
                          className="flex w-full items-center"
                          onClick={(e) => {
                            // Prevent navigation and toggle submenu only if user has any visible subitems
                            if (
                              !isSidebarCollapsed &&
                              visibleSubItems.length > 0
                            ) {
                              e.preventDefault();
                              updateOpenState(item.id, !openStates[item.id]);
                            }
                          }}
                        >
                          {/* Icon + label spacing: adjust gap here */}
                          <div className="flex w-full items-center justify-start gap-3 transition-[gap] duration-300 ease-out group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0">
                            <item.icon className="h-[1.1rem] w-[1.1rem] shrink-0 stroke-[1.6] transition-[width,height,transform] duration-300 ease-out" />
                            <span className="max-w-[12rem] overflow-hidden whitespace-nowrap font-medium opacity-100 transition-[max-width,opacity,transform] duration-300 ease-out group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:-translate-x-2 group-data-[collapsible=icon]:opacity-0">
                              {item.label}
                            </span>
                          </div>
                        </Link>
                      </SidebarMenuButton>
                      {visibleSubItems.length > 0 && (
                        <button
                          className={`overflow-hidden rounded-md bg-transparent p-2 transition-[max-width,opacity,padding,color] duration-300 ease-out hover:bg-transparent group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:opacity-0 ${
                            pathname.startsWith(item.href) &&
                            (pathname === item.href ||
                              pathname[item.href.length] === "/")
                              ? "max-w-10 text-white hover:text-white"
                              : "max-w-10 text-inherit hover:text-inherit"
                          }`}
                          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.stopPropagation();
                            updateOpenState(item.id, !openStates[item.id]);
                          }}
                          tabIndex={isSidebarCollapsed ? -1 : 0}
                        >
                          <ChevronRight
                            className={`h-[1rem] w-[1rem] stroke-[1.6] transition-transform duration-300 ease-out ${
                              openStates[item.id] && !isSidebarCollapsed
                                ? "rotate-90"
                                : "rotate-0"
                            }`}
                          />
                        </button>
                      )}
                    </div>
                    <CollapsibleContent className="mt-1">
                      {/* Submenu spacing: adjust ml-* and space-y-* to make open section smaller */}
                      <SidebarMenuSub className="space-y-0.5 ml-4">
                        {visibleSubItems.map((subItem) => {
                          const isObject = typeof subItem === "object";
                          const label = isObject ? subItem.label : subItem;
                          const path = isObject ? subItem.path : `/${subItem}`;
                          const subHref = `${item.href}${path}`;
                          // Only highlight if the current path exactly matches the subitem's href
                          // or if it's the base path and the current path matches exactly
                          const subActive =
                            pathname === subHref ||
                            (path === "" && pathname === item.href);

                          return (
                            <SidebarMenuSubItem
                              key={isObject ? subItem.label : subItem}
                            >
                              <SidebarMenuSubButton
                                asChild
                                className={`pl-4 w-full text-left transition-colors active:bg-transparent ${
                                  subActive
                                    ? "text-orange-600 font-medium dark:text-orange-400"
                                    : "text-muted-foreground hover:text-orange-600 dark:hover:text-orange-400"
                                }`}
                              >
                                <Link href={subHref}>{label}</Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          );
                        })}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              );
            } else {
              return (
                <SidebarMenuItem key={item.id} className="group">
                  <div
                    className={`flex w-full items-center rounded-lg px-3 py-2 transition-[padding,background-color,color] duration-300 ease-out group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0 ${
                      pathname.startsWith(item.href) &&
                      (pathname === item.href ||
                        pathname[item.href.length] === "/")
                        ? "bg-orange-600 text-white hover:bg-orange-600 hover:text-white"
                        : "text-foreground hover:bg-orange-100 dark:hover:bg-orange-900/30 hover:text-orange-600"
                    }`}
                  >
                    <SidebarMenuButton
                      asChild
                      tooltip={{
                        children: item.label,
                        className:
                          "!bg-orange-600 !text-white border-orange-500 shadow-lg",
                        arrowClassName: "bg-orange-600 fill-orange-600",
                      }}
                      className="w-full text-inherit transition-[width,height,padding,gap] duration-300 ease-out hover:bg-transparent hover:text-inherit active:bg-transparent active:text-inherit focus-visible:ring-0"
                    >
                      <Link
                        href={item.href}
                        className="flex w-full items-center"
                      >
                        <div className="flex w-full items-center justify-start gap-3 transition-[gap] duration-300 ease-out group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0">
                          <item.icon className="h-[1.1rem] w-[1.1rem] shrink-0 stroke-[1.6] transition-[width,height,transform] duration-300 ease-out" />
                          <span className="max-w-[12rem] overflow-hidden whitespace-nowrap font-medium opacity-100 transition-[max-width,opacity,transform] duration-300 ease-out group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:-translate-x-2 group-data-[collapsible=icon]:opacity-0">
                            {item.label}
                          </span>
                        </div>
                      </Link>
                    </SidebarMenuButton>
                  </div>
                </SidebarMenuItem>
              );
            }
          })}
        </SidebarMenu>
      </SidebarGroup>
    </div>
  );
};

export default NavSidebar;
