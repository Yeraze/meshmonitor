export type TemperatureUnit = 'C' | 'F';

function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9/5) + 32;
}

function fahrenheitToCelsius(fahrenheit: number): number {
  return (fahrenheit - 32) * 5/9;
}

export function formatTemperature(value: number, fromUnit: TemperatureUnit, toUnit: TemperatureUnit): number {
  if (fromUnit === toUnit) {
    return value;
  }

  if (fromUnit === 'C' && toUnit === 'F') {
    return celsiusToFahrenheit(value);
  }

  if (fromUnit === 'F' && toUnit === 'C') {
    return fahrenheitToCelsius(value);
  }

  return value;
}

export function getTemperatureUnit(unit: TemperatureUnit): string {
  return unit === 'C' ? '°C' : '°F';
}