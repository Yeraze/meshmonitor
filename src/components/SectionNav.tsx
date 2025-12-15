import React from 'react';

export interface NavItem {
  id: string;
  label: string;
}

interface SectionNavProps {
  items: NavItem[];
}

const SectionNav: React.FC<SectionNavProps> = ({ items }) => {
  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      // Account for fixed header (60px) + sticky nav (~50px) + padding (16px)
      const offset = 130;
      const elementPosition = element.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({
        top: elementPosition - offset,
        behavior: 'smooth'
      });
    }
  };

  return (
    <nav className="section-nav">
      {items.map((item) => (
        <button
          key={item.id}
          className="section-nav-item"
          onClick={() => scrollToSection(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
};

export default SectionNav;
